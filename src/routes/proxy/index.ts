import {
  EXCLUDED_PROVIDER_MODELS,
  CODEX_CLI_ORIGINATOR,
  CODEX_CLI_USER_AGENT,
  CODEX_SESSION_AFFINITY,
  CODEX_SESSION_AFFINITY_MAX_ENTRIES,
  HANG_RETRY_INTERVAL_MS,
  HANG_RETRY_MAX_DURATION_MS,
  MAX_ACCOUNT_RETRY_ATTEMPTS,
  MODELS_CACHE_MS,
  MODELS_CLIENT_VERSION,
  OPENCODE_BASE_URL,
  MODELS_STALE_MAX_AGE_MS,
  MODELS_STALE_WHILE_REVALIDATE,
  PI_USER_AGENT,
  PROXY_MODELS,
  TRACE_INCLUDE_BODY,
  TRACE_INCLUDE_HEADERS,
  UPSTREAM_COMPACT_PATH,
  UPSTREAM_PATH,
  USAGE_STALE_MAX_AGE_MS,
  USAGE_STALE_WHILE_REVALIDATE,
  XAI_BASE_URL,
  XAI_CHAT_COMPLETIONS_PATH,
  XAI_MODELS_PATH,
  ZAI_MODELS_PATH,
  XAI_RESPONSES_PATH,
} from "../../config.js";
import {
  buildModelsListResponse,
  toOpenAiModelShape,
} from "./models-response.js";
import type {
  Account,
  ModelAlias,
  ProviderId,
  UpstreamMode,
} from "../../types.js";
import {
  accountSelectionPool,
  accountHeadroom,
  accountUsable,
  clearEmptyResponseHistory,
  getZaiBlockDuration,
  isQuotaErrorText,
  markEmptyResponseError,
  markModelNotFound,
  markQuotaHit,
  normalizeProvider,
  parseZaiErrorCode,
  rememberError,
  selectAccountForProvider,
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
import {
  traceHeadersForRequest,
  TRACE_HEADERS_FORWARD_HEADER,
} from "../../trace-headers.js";
import {
  accountNeedsRequestPreparation,
  ensureValidToken,
} from "../../account-utils.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { maybeConsumeScheduledWeeklyReset } from "../../rate-limit-reset.js";
import { UsageRefreshCoordinator } from "../../usage-refresh.js";
import {
  AsyncRefreshCoordinator,
  canServeStaleSnapshot,
} from "../../async-refresh.js";
import { fetchUpstreamWithRetry } from "../../upstream-retry.js";
import {
  createResponseStreamDiagnostics,
  extractSSEFrameUsage,
  inspectResponseStreamEvent,
  inspectResponseStreamFrame,
  responseStreamFrameHasMeaningfulOutput,
} from "../../responses/stream-diagnostics.js";
import { createSSEStreamTap } from "../../responses/sse-stream-tap.js";
import { createUpstreamPayloadSerializer } from "../../responses/upstream-payload-serializer.js";
import { buildXaiUpstreamHeaders } from "../../xai.js";
import {
  extractCodexProjectHost,
  extractCodexProjectRoot,
  extractCodexSessionId,
  extractLiteLLMProjectAttribution,
} from "../../codex-projects.js";
import {
  buildClaudeCodeModelsResponse,
  handleAnthropicMessages,
  isClaudeCodeRequest,
} from "../../anthropic-compat.js";
import {
  accountSupportsModelByAvailability,
  createProviderModelAvailability,
  finalizeProviderModelAvailability,
  recordDiscoveredModel,
  type ModelAvailabilityByProvider,
} from "./model-availability.js";
import {
  aliasCandidateModels,
  allAliasCandidateModels,
  capacityTokenUsage,
  type CapacityLease,
  type CapacityTracker,
  type PolicyDecision,
  type RoutingRequest,
} from "../../smart-routing.js";
import type { SmartRoutingCoordinator } from "../../smart-routing-routes.js";
import {
  findSessionAffinityAccount,
  preferSessionAffinityAccount,
  SessionAffinityCache,
} from "../../session-affinity.js";

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
  capacityTracker?: CapacityTracker;
  smartRoutingCoordinator?: SmartRoutingCoordinator;
  sessionAffinityCache?: SessionAffinityCache;
  sessionAffinityEnabled?: boolean;
};

const modelsCache: {
  at: number;
  models: ExposedModel[];
  store?: AccountStore;
  revision: number;
} = {
  at: 0,
  models: [],
  revision: -1,
};
const modelsRefreshCoordinator =
  new AsyncRefreshCoordinator<ExposedModel[]>();
// Internal routing metadata. It is intentionally not exposed in /models.
const modelAvailabilityByProvider: ModelAvailabilityByProvider = new Map();

type RevisionedAccountStore = AccountStore & {
  getRevision?: () => number;
};

function accountStoreRevision(store: AccountStore): number {
  const revisionedStore = store as RevisionedAccountStore;
  return typeof revisionedStore.getRevision === "function"
    ? revisionedStore.getRevision()
    : 0;
}

// Separate cache for fast O(1) model validation using Set
const modelsValidationCache: {
  at: number;
  validModels: Set<string>;
  validModelKeys: Set<string>;
  complete: boolean;
} = {
  at: 0,
  validModels: new Set(),
  validModelKeys: new Set(),
  complete: false,
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
  /** Native Codex `/models` entry, retained for Codex CLI compatibility. */
  codexModelInfo?: Record<string, unknown>;
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
  options: {
    model?: string;
    conversationId?: string;
    opencodeHeaders?: Record<string, string>;
  } = {},
): Record<string, string> {
  if (provider === "xai") {
    return buildXaiUpstreamHeaders(accessToken, options);
  }
  const isOpenAI = provider === "openai";
  return {
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
    accept: "text/event-stream",
    originator: isOpenAI ? CODEX_CLI_ORIGINATOR : "pi",
    "User-Agent": isOpenAI ? CODEX_CLI_USER_AGENT : PI_USER_AGENT,
    ...(isOpenAI ? { version: MODELS_CLIENT_VERSION } : {}),
    ...(provider === "opencode" && options.opencodeHeaders
      ? options.opencodeHeaders
      : {}),
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

export type PayloadContextInspection = {
  hasImage: boolean;
  compactionItemCount: number;
  latestCompactionIndex: number;
};

export function inspectPayloadContext(payload: any): PayloadContextInspection {
  let hasImage = false;
  let compactionItemCount = 0;
  let latestCompactionIndex = -1;
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const part of content) {
      const type = typeof part?.type === "string" ? part.type : "";
      if (type.includes("image")) hasImage = true;
    }
  }

  const input = Array.isArray(payload?.input) ? payload.input : [];
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    const itemType = typeof item?.type === "string" ? item.type : "";
    if (itemType.includes("image")) hasImage = true;
    if (itemType === "compaction") {
      compactionItemCount += 1;
      latestCompactionIndex = index;
    }
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const type = typeof part?.type === "string" ? part.type : "";
      if (type.includes("image")) hasImage = true;
    }
  }

  return {
    hasImage,
    compactionItemCount,
    latestCompactionIndex,
  };
}

export function payloadHasImage(payload: any): boolean {
  return inspectPayloadContext(payload).hasImage;
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

function buildImagePayloadTrace(
  incomingPayload: any,
  upstreamPayload: any,
  incomingHasImage = payloadHasImage(incomingPayload),
): ImagePayloadTrace | undefined {
  if (!incomingHasImage) return undefined;
  const incoming = summarizeImagePayload(incomingPayload);
  const upstream = summarizeImagePayload(upstreamPayload);
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
    "max_completion_tokens",
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
      : typeof upstreamObject.supports_reasoning_effort === "boolean"
        ? upstreamObject.supports_reasoning_effort
      : id.includes("gpt-5") || id.includes("codex");

  return {
    id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: provider,
    ...(provider === "openai" &&
    typeof upstreamObject.slug === "string" &&
    upstreamObject.slug.trim()
      ? { codexModelInfo: { ...upstreamObject } }
      : {}),
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

function fallbackModelCatalog(): ExposedModel[] {
  return Array.from(new Set(PROXY_MODELS)).map((id) =>
    modelObject(id, "openai"),
  );
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isHopByHopHeader(name: string): boolean {
  return HOP_BY_HOP_HEADERS.has(name.toLowerCase());
}

export function shouldForwardDecodedResponseHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return !isHopByHopHeader(normalized) && normalized !== "content-encoding";
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
  if (provider === "opencode") {
    return trimTrailingSlash(account.baseUrl ?? OPENCODE_BASE_URL);
  }
  if (provider === "mistral") return mistralBaseUrl;
  if (provider === "zai") return zaiBaseUrl;
  if (provider === "xai") {
    return trimTrailingSlash(account.baseUrl ?? XAI_BASE_URL);
  }
  return openaiBaseUrl;
}

export function resolveUpstreamMode(
  account: {
    provider?: ProviderId;
    upstreamMode?: UpstreamMode;
    compatibilityMode?: string;
  },
  isChatCompletionsPath: boolean,
  isResponsesCompactPath: boolean,
): UpstreamMode {
  if (account.upstreamMode) return account.upstreamMode;
  const provider = normalizeProvider(account);
  if (provider === "zai") return "chat/completions";
  if (isResponsesCompactPath) return "responses";
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
    codexModelInfo: current?.codexModelInfo ?? nextModel.codexModelInfo,
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

function xaiModelEntries(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (!payload?.models || typeof payload.models !== "object") return [];
  return Object.entries(payload.models).map(([id, value]: [string, any]) => ({
    id,
    ...(value?.info && typeof value.info === "object" ? value.info : value),
  }));
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

  if (key.startsWith("grok-") || key === "grok") {
    return "xai";
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
  provider: ProviderId,
  model: string | undefined,
  discoveredModels: ExposedModel[],
): boolean {
  const key = normalizeModelLookupKey(model);
  if (!key) return true;

  const discovered = discoveredModels.find(
    (entry) => normalizeModelLookupKey(entry.id) === key,
  );
  if (!discovered) return true;

  return accountSupportsModelByAvailability(
    accountId,
    provider,
    key,
    modelAvailabilityByProvider,
  );
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
  if (provider === "openai-compatible" || provider === "opencode") {
    return new Set(["function"]);
  }

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

async function refreshModels(
  store: AccountStore,
  openaiBaseUrl: string,
  mistralBaseUrl: string,
  zaiBaseUrl: string,
): Promise<ExposedModel[]> {
  const sourceRevision = accountStoreRevision(store);
  try {
    const accounts = await store.listAccounts();
    const byId = new Map<string, ExposedModel>();
    const activeAccounts = accounts.filter((a) => a.enabled && a.accessToken);
    const discoveredAvailabilityByProvider: ModelAvailabilityByProvider =
      new Map();
    for (const account of activeAccounts) {
      const provider = normalizeProvider(account);
      const availability =
        discoveredAvailabilityByProvider.get(provider) ??
        createProviderModelAvailability();
      availability.activeAccountIds.add(account.id);
      discoveredAvailabilityByProvider.set(provider, availability);
    }
    let catalogComplete = activeAccounts.length > 0;

    for (const account of activeAccounts) {
      const provider = normalizeProvider(account);
      try {
        const headers: Record<string, string> =
          provider === "xai"
            ? buildXaiUpstreamHeaders(account.accessToken, {
                accept: "application/json",
              })
            : {
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
        } else if (provider === "xai") {
          const baseUrl = accountBaseUrl(
            account,
            openaiBaseUrl,
            mistralBaseUrl,
            zaiBaseUrl,
          );
          if (!baseUrl) {
            catalogComplete = false;
            continue;
          }
          url = `${baseUrl}${XAI_MODELS_PATH}`;
        } else {
          const baseUrl = accountBaseUrl(
            account,
            openaiBaseUrl,
            mistralBaseUrl,
            zaiBaseUrl,
          );
          if (!baseUrl) {
            catalogComplete = false;
            continue;
          }
          if (
            provider === "opencode" &&
            /^https:\/\/opencode\.ai\/inference\/openai$/i.test(baseUrl)
          ) {
            // OpenCode OAuth routes inference through this account-specific
            // base, but it does not expose a model-list endpoint there. Use
            // the public Zen catalog for discovery; inference still uses the
            // account base URL below.
            url = `${trimTrailingSlash(OPENCODE_BASE_URL)}/v1/models`;
          } else {
            url = `${baseUrl}${provider === "zai" ? ZAI_MODELS_PATH : "/v1/models"}`;
          }
        }

        const r = await fetch(url, { headers });
        if (!r.ok) {
          catalogComplete = false;
          continue;
        }
        const json: any = await r.json();

        if (provider === "openai") {
          if (!Array.isArray(json?.models) || json.models.length === 0) {
            catalogComplete = false;
            continue;
          }
          const upstream = json.models;
          const availability = discoveredAvailabilityByProvider.get(provider);
          availability?.successfulAccountIds.add(account.id);
          for (const entry of upstream) {
            const slug =
              typeof entry?.slug === "string" && entry.slug.trim()
                ? entry.slug.trim()
                : "";
            if (!slug) continue;
            if (availability) {
              recordDiscoveredModel(
                availability,
                normalizeModelLookupKey(slug),
                account.id,
              );
            }
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

        const upstream =
          provider === "xai"
            ? xaiModelEntries(json)
            : Array.isArray(json?.data)
              ? json.data
              : [];
        if (upstream.length === 0) {
          catalogComplete = false;
          continue;
        }
        const availability = discoveredAvailabilityByProvider.get(provider);
        availability?.successfulAccountIds.add(account.id);
        for (const entry of upstream) {
          const id =
            typeof entry?.id === "string" && entry.id.trim()
              ? entry.id.trim()
              : "";
          if (!id) continue;
          if (availability) {
            recordDiscoveredModel(
              availability,
              normalizeModelLookupKey(id),
              account.id,
            );
          }
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
      } catch {
        catalogComplete = false;
      }
    }

    for (const availability of discoveredAvailabilityByProvider.values()) {
      finalizeProviderModelAvailability(availability);
    }
    modelAvailabilityByProvider.clear();
    for (const [provider, availability] of discoveredAvailabilityByProvider) {
      modelAvailabilityByProvider.set(provider, availability);
    }

    for (const id of PROXY_MODELS) {
      if (!byId.has(id)) byId.set(id, modelObject(id, "openai"));
    }

    const aliases = store
      .getCachedModelAliases()
      .filter((a) => a.enabled && allAliasCandidateModels(a).length > 0);
    for (const alias of aliases) {
      const aliasTargets = allAliasCandidateModels(alias);
      const firstTarget = aliasTargets[0];
      const aliasTarget = Array.from(byId.values()).find(
        (model) =>
          normalizeModelLookupKey(model.id) ===
          normalizeModelLookupKey(firstTarget),
      );
      const providers = providersForModel(
        firstTarget,
        Array.from(byId.values()),
      );
      const provider =
        providers[0] ??
        inferProviderFromModel(firstTarget, Array.from(byId.values()));
      byId.set(alias.id, {
        ...modelObject(alias.id, provider),
        ...(aliasTarget?.codexModelInfo
          ? {
              codexModelInfo: {
                ...aliasTarget.codexModelInfo,
                slug: alias.id,
                display_name: alias.id,
                description: `Alias for ${firstTarget}`,
                visibility: "list",
              },
            }
          : {}),
        metadata: {
          ...modelObject(alias.id, provider).metadata,
          provider_candidates: providers,
          is_alias: true,
          alias_targets: aliasTargets,
        },
      });
    }
    if (!byId.size) throw new Error("no models discovered");

    const merged = Array.from(byId.values());
    modelsCache.at = Date.now();
    modelsCache.models = merged;
    modelsCache.store = store;
    modelsCache.revision = sourceRevision;
    updateValidationCache(merged, catalogComplete);
    return merged;
  } catch {
    modelAvailabilityByProvider.clear();
    const fallback = fallbackModelCatalog();
    modelsCache.at = Date.now();
    modelsCache.models = fallback;
    modelsCache.store = store;
    modelsCache.revision = sourceRevision;
    updateValidationCache(fallback, false);
    return fallback;
  }
}

type DiscoverModelsOptions = {
  staleWhileRevalidate?: boolean;
  maxStaleAgeMs?: number;
  onPrepared?: (
    mode: "fresh" | "background" | "blocking",
    shared: boolean,
  ) => void;
};

export async function discoverModels(
  store: AccountStore,
  openaiBaseUrl: string,
  mistralBaseUrl: string,
  zaiBaseUrl: string,
  options: DiscoverModelsOptions = {},
): Promise<ExposedModel[]> {
  const cacheAgeMs = Math.max(0, Date.now() - modelsCache.at);
  const storeRevision = accountStoreRevision(store);
  const hasCurrentSnapshot =
    modelsCache.models.length > 0 &&
    modelsCache.store === store &&
    modelsCache.revision === storeRevision;
  if (cacheAgeMs < MODELS_CACHE_MS && hasCurrentSnapshot) {
    options.onPrepared?.("fresh", false);
    return modelsCache.models;
  }

  // The router starts a discovery in the background at construction time.
  // A request arriving during that first probe must not inherit all provider
  // network latency just because no catalog has been observed yet. The
  // fallback is deliberately not stored as the cache: the in-flight refresh
  // still publishes the real catalog when it completes.
  if (!modelsCache.models.length && options.staleWhileRevalidate) {
    const prepared = await modelsRefreshCoordinator.prepare({
      staleValue: fallbackModelCatalog(),
      staleWhileRevalidate: true,
      refresh: () =>
        refreshModels(store, openaiBaseUrl, mistralBaseUrl, zaiBaseUrl),
    });
    options.onPrepared?.(prepared.mode, prepared.shared);
    return prepared.value;
  }

  const canUseStale = canServeStaleSnapshot({
    enabled: Boolean(options.staleWhileRevalidate),
    hasSnapshot: hasCurrentSnapshot,
    ageMs: cacheAgeMs,
    maxAgeMs: options.maxStaleAgeMs ?? Infinity,
  });
  const prepared = await modelsRefreshCoordinator.prepare({
    staleValue: canUseStale ? modelsCache.models : undefined,
    staleWhileRevalidate: canUseStale,
    refresh: () =>
      refreshModels(store, openaiBaseUrl, mistralBaseUrl, zaiBaseUrl),
  });
  options.onPrepared?.(prepared.mode, prepared.shared);

  // If the shared refresh started before an account or alias mutation, it
  // published a catalog for an older store revision. Retry for blocking
  // callers so a newly connected provider is visible immediately.
  if (
    prepared.mode === "blocking" &&
    (modelsCache.store !== store ||
      modelsCache.revision !== accountStoreRevision(store))
  ) {
    return discoverModels(
      store,
      openaiBaseUrl,
      mistralBaseUrl,
      zaiBaseUrl,
      options,
    );
  }
  return prepared.value;
}

function updateValidationCache(
  models: ExposedModel[],
  complete: boolean,
): void {
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
  modelsValidationCache.complete = complete;
}

export function isModelAllowedByKeys(
  model: string | undefined,
  validModelKeys: ReadonlySet<string>,
  catalogComplete = true,
): boolean {
  if (!model) return true; // No model specified, let it pass
  // Discovery depends on every configured provider being reachable. A partial
  // catalog must fail open or a transient provider error can make valid models
  // disappear until the cache expires or the proxy restarts.
  if (!catalogComplete || validModelKeys.size === 0) return true;
  const key = normalizeModelLookupKey(model);
  return validModelKeys.has(key);
}

function isModelAllowed(model: string | undefined): boolean {
  return isModelAllowedByKeys(
    model,
    modelsValidationCache.validModelKeys,
    modelsValidationCache.complete,
  );
}

function startBackgroundModelRefresh(
  store: AccountStore,
  openaiBaseUrl: string,
  mistralBaseUrl: string,
  zaiBaseUrl: string,
): void {
  const refreshAndLog = async (label: "Initial" | "Background") => {
    try {
      const models = await discoverModels(
        store,
        openaiBaseUrl,
        mistralBaseUrl,
        zaiBaseUrl,
      );
      console.log(
        `[model-cache] ${label} refresh: ${models.length} models available`,
      );
    } catch (err) {
      console.error(`[model-cache] ${label} refresh failed:`, err);
    }
  };

  // Begin discovery as soon as the router is created. Requests arriving while
  // it is still running join the same coordinator instead of starting a
  // duplicate refresh.
  void refreshAndLog("Initial");

  // Refresh validation cache every 60 seconds asynchronously
  const interval = setInterval(() => {
    void refreshAndLog("Background");
  }, MODELS_VALIDATION_CACHE_MS);
  interval.unref?.();
}

const EFFORT_TIERS = ["minimal", "low", "medium", "high", "xhigh"] as const;
type EffortTier = (typeof EFFORT_TIERS)[number];

const EFFORT_TARGET_RE = /^(minimal|low|medium|high|xhigh):(.+)$/;

const UNSUPPORTED_VALUE_RE =
  /Unsupported value:\s*['"]([^'"]+)['"][\s\S]*?Supported values? (?:are|is):\s*([^\n.}]+)/i;

function closestSupportedValue(
  rejected: string,
  supported: readonly string[],
): string | undefined {
  if (supported.length === 0) return undefined;
  const rejectedIndex = EFFORT_TIERS.indexOf(rejected as EffortTier);
  if (rejectedIndex < 0) return supported[0];

  return [...supported].sort((left, right) => {
    const leftIndex = EFFORT_TIERS.indexOf(left as EffortTier);
    const rightIndex = EFFORT_TIERS.indexOf(right as EffortTier);
    const leftDistance =
      leftIndex < 0
        ? Number.MAX_SAFE_INTEGER
        : Math.abs(leftIndex - rejectedIndex);
    const rightDistance =
      rightIndex < 0
        ? Number.MAX_SAFE_INTEGER
        : Math.abs(rightIndex - rejectedIndex);
    return leftDistance - rightDistance;
  })[0];
}

/**
 * Correct a reasoning-effort enum rejected by an OpenAI-compatible upstream.
 * The error response is authoritative, which avoids maintaining a model/version
 * compatibility table in the proxy as providers add models.
 */
export function applyUnsupportedValueCorrection(
  payload: any,
  errorText: string,
): { from: string; to: string } | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const match = errorText.match(UNSUPPORTED_VALUE_RE);
  if (!match) return undefined;

  const rejected = match[1];
  const supported = [...match[2].matchAll(/['"]([^'"]+)['"]/g)].map(
    (entry) => entry[1],
  );
  const replacement = closestSupportedValue(rejected, supported);
  if (!replacement || replacement === rejected) return undefined;

  if (payload.reasoning_effort === rejected) {
    payload.reasoning_effort = replacement;
    return { from: rejected, to: replacement };
  }
  if (
    payload.reasoning &&
    typeof payload.reasoning === "object" &&
    payload.reasoning.effort === rejected
  ) {
    payload.reasoning.effort = replacement;
    return { from: rejected, to: replacement };
  }
  return undefined;
}

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
  if (alias) {
    targets = aliasCandidateModels(alias, requestEffort);
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
    const tryProviders: ProviderId[] = [
      "openai",
      "openai-compatible",
      "opencode",
      "mistral",
      "zai",
      "xai",
    ];
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
  requestHasImage = payloadHasImage(requestBody),
): RoutingCandidate[] {
  const requestModel =
    typeof requestBody?.model === "string" && requestBody.model.trim()
      ? requestBody.model.trim()
      : undefined;
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForHangRetry(
  ms: number,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await sleep(ms, signal);
    return true;
  } catch (error) {
    if (signal.aborted) return false;
    throw error;
  }
}

export function isStreamingUpstreamResponse(
  contentType: string,
  clientRequestedStream: boolean,
  upstreamOk: boolean,
  provider: string,
  hasBody: boolean,
): boolean {
  // Error streams must be buffered first so quota/model routing can inspect
  // their payload and rotate accounts before anything is sent to the client.
  if (!upstreamOk) return false;
  if (contentType.includes("text/event-stream")) return true;
  // ChatGPT's Responses endpoint currently streams SSE without consistently
  // returning a Content-Type header. A successful OpenAI response to an
  // explicitly streamed request must therefore be relayed as a stream rather
  // than buffered before tracing and delivery.
  return (
    clientRequestedStream &&
    upstreamOk &&
    provider === "openai" &&
    hasBody
  ) || (
    clientRequestedStream &&
    upstreamOk &&
    provider === "xai" &&
    hasBody
  );
}

export function classifyNativeStreamCompletion(
  clientDisconnected: boolean,
  sawResponseCompleted: boolean,
  streamError?: Error,
) {
  const interrupted =
    !sawResponseCompleted &&
    (Boolean(streamError) || clientDisconnected);
  return {
    interrupted,
    status: sawResponseCompleted
      ? 200
      : streamError
      ? 599
      : clientDisconnected
        ? 499
        : 200,
    clientDisconnected:
      clientDisconnected && !sawResponseCompleted ? true : undefined,
    error: sawResponseCompleted
      ? undefined
      : clientDisconnected
        ? "client disconnected before stream completion"
        : streamError?.message,
  };
}

function isModelNotFoundError(status: number, errorText: string): boolean {
  return (
    (status === 400 || status === 404) &&
    /\bmodel(?:\s+['"`]?[^'"`\s]+['"`]?)?\s+not\s+found\b|\bmodel_not_found\b/i.test(
      errorText,
    )
  );
}

export function createProxyRouter(options: ProxyRoutesOptions) {
  const sessionAffinity =
    options.sessionAffinityCache ??
    new SessionAffinityCache(undefined, CODEX_SESSION_AFFINITY_MAX_ENTRIES);
  const sessionAffinityEnabled =
    options.sessionAffinityEnabled ?? CODEX_SESSION_AFFINITY;
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
    capacityTracker,
    smartRoutingCoordinator,
  } = options;
  const { recordTrace } = traceManager;
  const router = express.Router();
  const usageRefreshCoordinator = new UsageRefreshCoordinator();

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
    const requestAbortController = new AbortController();
    const abortRequest = () => {
      if (res.writableEnded || requestAbortController.signal.aborted) return;
      requestAbortController.abort();
    };
    const cleanupRequestCancellation = () => {
      req.off("aborted", abortRequest);
      res.off("close", abortRequest);
      res.off("close", cleanupRequestCancellation);
      res.off("finish", cleanupRequestCancellation);
    };
    req.once("aborted", abortRequest);
    res.once("close", abortRequest);
    res.once("close", cleanupRequestCancellation);
    res.once("finish", cleanupRequestCancellation);
    const requestSignal = requestAbortController.signal;
    const reservedCapacityLease = res.locals.multivibeCapacityLease as
      | CapacityLease
      | undefined;
    let reservationReleased = false;
    let completedRoutingAccountId: string | undefined;
    let currentCapacityObservation:
      | { inputTokens?: number; outputTokens?: number }
      | undefined;
    const observeCapacityUsage = (usage: any) => {
      if (!currentCapacityObservation || !usage) return;
      const observed = capacityTokenUsage(usage);
      if (observed.inputTokens !== undefined) {
        currentCapacityObservation.inputTokens = observed.inputTokens;
      }
      if (observed.outputTokens !== undefined) {
        currentCapacityObservation.outputTokens = observed.outputTokens;
      }
    };
    const application =
      typeof res.locals.proxyApplication === "string"
        ? res.locals.proxyApplication
        : undefined;
    const affinityApplication = application ?? "default";
    const requestHeaders = TRACE_INCLUDE_HEADERS
      ? traceHeadersForRequest(req.headers)
      : undefined;
    const codexSessionId = extractCodexSessionId(req.headers);
    const codexProjectHost = extractCodexProjectHost(req.headers);
    const codexProjectRoot = extractCodexProjectRoot(req.headers);
    const projectAttribution = extractLiteLLMProjectAttribution(req.headers);
    const recordTrace = (
      entry: Parameters<typeof traceManager.recordTrace>[0],
    ) => {
      observeCapacityUsage(entry.usage);
      return traceManager.recordTrace({
        ...entry,
        ...projectAttribution,
        application,
        codexSessionId,
        codexProjectHost,
        codexProjectRoot,
        requestHeaders,
      });
    };
    const beginTrace = (
      entry: Parameters<typeof traceManager.beginTrace>[0],
    ) =>
      traceManager.beginTrace({
        ...entry,
        ...projectAttribution,
        application,
        codexSessionId,
        codexProjectHost,
        codexProjectRoot,
        requestHeaders,
      });
    const completeTrace = (
      id: string,
      entry: Parameters<typeof traceManager.completeTrace>[1],
    ) => {
      observeCapacityUsage(entry.usage);
      return traceManager.completeTrace(id, {
        ...entry,
        ...projectAttribution,
        application,
        codexSessionId,
        codexProjectHost,
        codexProjectRoot,
        requestHeaders,
      });
    };
    const usageRefreshTrace = {
      background: 0,
      blocking: 0,
      shared: 0,
    };
    const modelCatalogRefreshTrace = {
      background: 0,
      blocking: 0,
      shared: 0,
    };
    const accountPreparationTrace = {
      skipped: 0,
      asynchronous: 0,
    };
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
    const isNativeResponsesStream =
      clientRequestedStream && !isChatCompletionsPath;
    let nativeStreamTraceId: string | undefined;
    let nativeStreamTracePromise: Promise<string> | undefined;
    let nativeStreamKeepalive: ReturnType<typeof setInterval> | undefined;

    const startNativeStreamTrace = () =>
      beginTrace({
        at: startedAt,
        startedAt,
        route: req.path,
        model:
          typeof req.body?.model === "string" ? req.body.model : undefined,
        status: 102,
        stream: true,
        latencyMs: 0,
        requestBody: TRACE_INCLUDE_BODY ? req.body : undefined,
      });

    if (isNativeResponsesStream) {
      res.status(200);
      res.set("Content-Type", "text/event-stream");
      res.set("Cache-Control", "no-cache");
      res.set("Connection", "keep-alive");
      res.flushHeaders();
      res.write(": connected\n\n");
      nativeStreamKeepalive = setInterval(() => {
        if (!res.writableEnded) res.write(": keepalive\n\n");
      }, 5_000);
      nativeStreamKeepalive.unref?.();
      nativeStreamTracePromise = startNativeStreamTrace();
    }

    const sendPreparationError = async (
      status: number,
      error: string | Record<string, unknown>,
    ) => {
      const payload = { error };
      const errorMessage =
        typeof error === "string"
          ? error
          : typeof error.message === "string"
            ? error.message
            : JSON.stringify(error);

      if (isNativeResponsesStream && res.headersSent) {
        if (nativeStreamKeepalive) {
          clearInterval(nativeStreamKeepalive);
          nativeStreamKeepalive = undefined;
        }
        if (!res.writableEnded) {
          res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
          res.end();
        }
        if (nativeStreamTracePromise) {
          const traceId = await nativeStreamTracePromise;
          await completeTrace(traceId, {
            at: Date.now(),
            startedAt,
            route: req.path,
            model:
              typeof req.body?.model === "string"
                ? req.body.model
                : undefined,
            status,
            stream: true,
            latencyMs: Date.now() - startedAt,
            requestBody: TRACE_INCLUDE_BODY ? req.body : undefined,
            error: errorMessage,
            lifecycleState: "completed",
          });
        }
        return;
      }

      res.status(status).json(payload);
    };

    let accounts = store.getCachedAccounts();
    if (!accounts.length)
      return sendPreparationError(503, "no accounts configured");

    // Only refresh tokens/usage for enabled accounts. Skipping disabled
    // accounts avoids wasting API calls and prevents a race where stale
    // account objects overwrite admin changes (e.g. re-enabling a disabled
    // account).
    const prepareAccount = async (account: Account): Promise<Account> => {
      const valid = await ensureValidToken(account, oauthConfig);
      // Persist token refreshes before a background usage probe can complete.
      // The probe itself only patches the usage field, so it cannot overwrite
      // newer admin or routing state.
      if (valid !== account) {
        store.markAccountModified(valid.id, valid);
      }
      const usageBaseUrl = accountBaseUrl(
        valid,
        openaiBaseUrl,
        mistralBaseUrl,
        zaiBaseUrl,
      );
      const prepared = await usageRefreshCoordinator.prepare(
        valid,
        usageBaseUrl,
        {
          staleWhileRevalidate:
            USAGE_STALE_WHILE_REVALIDATE &&
            !valid.state?.scheduledWeeklyReset,
          maxStaleAgeMs: USAGE_STALE_MAX_AGE_MS,
          serveMissingSnapshotWhileRevalidating:
            USAGE_STALE_WHILE_REVALIDATE &&
            !valid.state?.scheduledWeeklyReset,
          onBackgroundUpdate: async (updated) => {
            if (updated.usage) {
              await store.patchAccount(updated.id, {
                usage: updated.usage,
              });
            }
          },
        },
      );
      if (prepared.mode === "background") {
        usageRefreshTrace.background += 1;
      } else if (prepared.mode === "blocking") {
        usageRefreshTrace.blocking += 1;
      }
      if (prepared.shared) usageRefreshTrace.shared += 1;
      if (prepared.mode === "blocking" && prepared.account !== valid) {
        store.markAccountModified(prepared.account.id, prepared.account);
      }
      if (
        normalizeProvider(prepared.account) === "openai" &&
        prepared.account.state?.scheduledWeeklyReset
      ) {
        await maybeConsumeScheduledWeeklyReset(
          prepared.account.id,
          store,
          openaiBaseUrl,
        );
      }
      return prepared.account;
    };
    const accountPreparations: Array<Account | Promise<Account>> = accounts.map(
      (account) => {
        if (accountNeedsRequestPreparation(account)) {
          accountPreparationTrace.asynchronous += 1;
          return prepareAccount(account);
        }
        accountPreparationTrace.skipped += 1;
        return account;
      },
    );
    const hasAsyncPreparation = accountPreparations.some(
      (account): account is Promise<Account> =>
        typeof (account as Promise<Account>)?.then === "function",
    );
    accounts = hasAsyncPreparation
      ? await Promise.all(accountPreparations)
      : (accountPreparations as Account[]);

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
      return sendPreparationError(400, {
          message: `Model '${requestModel}' is not supported. Use /v1/models to list available models.`,
          type: "invalid_request_error",
          code: "model_not_found",
      });
    }

    const discoveredModels = await discoverModels(
      store,
      openaiBaseUrl,
      mistralBaseUrl,
      zaiBaseUrl,
      {
        staleWhileRevalidate: MODELS_STALE_WHILE_REVALIDATE,
        maxStaleAgeMs: MODELS_STALE_MAX_AGE_MS,
        onPrepared: (mode, shared) => {
          if (mode === "background") {
            modelCatalogRefreshTrace.background += 1;
          } else if (mode === "blocking") {
            modelCatalogRefreshTrace.blocking += 1;
          }
          if (shared) modelCatalogRefreshTrace.shared += 1;
        },
      },
    );
    const modelAliases = store.getCachedModelAliases();
    const imageRequestModelOverride = store.getCachedSettings().imageRequestModelOverride;
    const incomingContextInspection = inspectPayloadContext(req.body);
    const requestHasImage = incomingContextInspection.hasImage;
    const serializeUpstreamPayload = createUpstreamPayloadSerializer();
    const routingCandidates = buildImageAwareRoutingCandidates(
      req.body,
      discoveredModels,
      modelAliases,
      imageRequestModelOverride,
      requestEffort,
      requestHasImage,
    );
    let policyDecision = res.locals.multivibePolicyDecision as
      | PolicyDecision
      | undefined;
    const routingRequest = res.locals.multivibeRouting as
      | RoutingRequest
      | undefined;
    const effectivePolicyModel =
      requestHasImage && imageRequestModelOverride
        ? imageRequestModelOverride
        : requestModel;
    if (smartRoutingCoordinator && routingRequest && effectivePolicyModel) {
      policyDecision = smartRoutingCoordinator.decision(
        effectivePolicyModel,
        routingRequest,
      );
    }
    res.once("finish", () => {
      if (
        res.statusCode < 500 &&
        completedRoutingAccountId &&
        routingRequest &&
        policyDecision
      ) {
        smartRoutingCoordinator?.recordCloudConsumption(
          routingRequest,
          policyDecision,
          completedRoutingAccountId,
        );
      }
    });
    if (policyDecision?.eligible.length) {
      const rank = new Map(
        policyDecision.eligible.map((entry, index) => [
          `${normalizeModelLookupKey(entry.config.model)}::${entry.resource.provider}`,
          index,
        ]),
      );
      routingCandidates.sort(
        (left, right) =>
          (rank.get(
            `${normalizeModelLookupKey(left.resolvedModel)}::${left.provider}`,
          ) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(
            `${normalizeModelLookupKey(right.resolvedModel)}::${right.provider}`,
          ) ?? Number.MAX_SAFE_INTEGER),
      );
      const allowedRoutes = new Set(rank.keys());
      const restricted = routingCandidates.filter((candidate) =>
        allowedRoutes.has(
          `${normalizeModelLookupKey(candidate.resolvedModel)}::${candidate.provider}`,
        ),
      );
      routingCandidates.splice(0, routingCandidates.length, ...restricted);
    }
    const maxAttempts = Math.min(accounts.length, MAX_ACCOUNT_RETRY_ATTEMPTS);
    let sawEmptyAssistantOutput = false;
    const hangStart = Date.now();

    // Outer hang loop: when all accounts are exhausted (e.g. all rate-limited),
    // sleep and retry instead of failing immediately, up to HANG_RETRY_MAX_DURATION_MS.
    while (true) {
      if (requestSignal.aborted) return;
      const tried = new Set<string>();
      let providerTried = false;

    for (const candidate of routingCandidates) {
      if (requestSignal.aborted) return;
      const policyAccountIds = policyDecision?.eligible.length
        ? new Set(
            policyDecision.eligible
              .filter(
                (entry) =>
                  normalizeModelLookupKey(entry.config.model) ===
                    normalizeModelLookupKey(candidate.resolvedModel) &&
                  entry.resource.provider === candidate.provider,
              )
              .map((entry) => entry.resource.accountId),
          )
        : undefined;
      const providerAccounts = accounts.filter(
        (a) =>
          normalizeProvider(a) === candidate.provider &&
          accountSupportsModel(
            a.id,
            candidate.provider,
            candidate.resolvedModel,
            discoveredModels,
          ) &&
          (!policyAccountIds || policyAccountIds.has(a.id)),
      );
      if (!providerAccounts.length) continue;
      providerTried = true;

      const attemptsForProvider = Math.min(
        providerAccounts.length,
        maxAttempts,
      );
      for (let i = 0; i < attemptsForProvider; i++) {
        if (requestSignal.aborted) return;
        const usableAccounts = providerAccounts.filter(
          (account) =>
            !tried.has(account.id) &&
            accountUsable(account, candidate.resolvedModel),
        );
        const preferredResource = policyDecision?.eligible.find(
          (entry) =>
            normalizeModelLookupKey(entry.config.model) ===
              normalizeModelLookupKey(candidate.resolvedModel) &&
            entry.resource.provider === candidate.provider &&
            usableAccounts.some(
              (account) => account.id === entry.resource.accountId,
            ),
        )?.resource;

        const quotaAwareAccounts = accountSelectionPool(usableAccounts);
        const previousAffinityAccountId =
          sessionAffinityEnabled && codexSessionId
            ? sessionAffinity.peek(
                affinityApplication,
                codexSessionId,
                candidate.provider,
              )
            : undefined;
        const affinityAccount = findSessionAffinityAccount(
          sessionAffinity,
          sessionAffinityEnabled,
          affinityApplication,
          codexSessionId,
          candidate.provider,
          quotaAwareAccounts,
        );

        // Policy constraints have already filtered providerAccounts above.
        // Within that eligible set, prefer the account already associated
        // with this Codex session to preserve cache locality. Smart-routing's
        // preferred resource remains the fallback for a new or invalidated
        // affinity.
        const preferredAccount = preferredResource
          ? quotaAwareAccounts.find(
              (account) => account.id === preferredResource.accountId,
            )
          : undefined;

        const quotaSelection = selectAccountForProvider(
          usableAccounts,
          candidate.provider,
        );
        const selected =
          preferSessionAffinityAccount(affinityAccount, preferredAccount) ??
          quotaSelection.account;

        if (!selected) break;

        const selectionReason = affinityAccount
          ? "sticky"
          : preferredAccount
            ? "policy-preferred"
            : "quota-headroom";
        const previousAttemptAccountId = completedRoutingAccountId;
        const selectedWeeklyRemainingPercent =
          typeof selected.usage?.secondary?.usedPercent === "number"
            ? 100 - Math.max(0, Math.min(100, selected.usage.secondary.usedPercent))
            : undefined;
        const selectedFiveHourRemainingPercent =
          typeof selected.usage?.primary?.usedPercent === "number"
            ? 100 - Math.max(0, Math.min(100, selected.usage.primary.usedPercent))
            : undefined;
        const accountSelection = {
          reason: selectionReason,
          provider: candidate.provider,
          candidateCount: quotaSelection.candidateCount,
          eligibleCount: quotaSelection.eligibleCount,
          nearLimitCount: quotaSelection.nearLimitCount,
          rotated: Boolean(
            (previousAttemptAccountId &&
              previousAttemptAccountId !== selected.id) ||
              (previousAffinityAccountId &&
                previousAffinityAccountId !== selected.id),
          ),
          selectedHeadroomPercent: accountHeadroom(selected),
          selectedWeeklyRemainingPercent,
          selectedFiveHourRemainingPercent,
        } as const;

        if (sessionAffinityEnabled && codexSessionId) {
          // Remember the last selected eligible account. If it fails and the
          // request rotates to another account, that later selection replaces
          // this mapping immediately.
          sessionAffinity.remember(
            affinityApplication,
            codexSessionId,
            candidate.provider,
            selected.id,
          );
        }

        completedRoutingAccountId = selected.id;
        let attemptCapacityLease: CapacityLease | undefined;

        if (capacityTracker && candidate.resolvedModel) {
          const reservationMatches =
            !reservationReleased &&
            reservedCapacityLease?.accountId === selected.id &&
            reservedCapacityLease.model.toLowerCase() ===
              candidate.resolvedModel.toLowerCase();
          if (reservationMatches) {
            attemptCapacityLease = reservedCapacityLease;
          } else if (reservedCapacityLease && !reservationReleased) {
            res.locals.multivibeCapacityLeaseClaimed = true;
            reservedCapacityLease.release();
            reservationReleased = true;
          }
          if (!res.headersSent) {
            res.setHeader(
              "X-MultiVibe-Decision",
              selected.location === "local" ? "local" : "cloud",
            );
            res.setHeader(
              "X-MultiVibe-Resolved-Model",
              candidate.resolvedModel,
            );
            res.setHeader(
              "X-MultiVibe-Capacity-Version",
              String(capacityTracker.getVersion()),
            );
          }
        }

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
        if (
          shouldSendChatCompletions &&
          (candidate.provider === "openai-compatible" ||
            candidate.provider === "opencode")
        ) {
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
        const imageTrace = buildImagePayloadTrace(
          req.body,
          payloadToUpstream,
          requestHasImage,
        );
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
        const executionLocation =
          selected.location === "local" ? ("local" as const) : ("cloud" as const);
        const latencyBreakdown = {
          preparationMs: 0,
          upstreamHeadersMs: 0,
        };
        let ttftMs: number | undefined;
        const markFirstOutput = (frame: string) => {
          if (
            ttftMs === undefined &&
            responseStreamFrameHasMeaningfulOutput(frame)
          ) {
            ttftMs = Date.now() - startedAt;
          }
        };
        const upstreamContextInspection =
          payloadToUpstream?.input === req.body?.input
            ? incomingContextInspection
            : inspectPayloadContext(payloadToUpstream);
        const {
          compactionItemCount,
          latestCompactionIndex,
        } = upstreamContextInspection;
        const traceImage = {
          provider: candidate.provider,
          get ttftMs() {
            return ttftMs;
          },
          ...(imageTrace ? { imageTrace } : {}),
          latencyBreakdown,
          ...(usageRefreshTrace.background ||
          usageRefreshTrace.blocking ||
          usageRefreshTrace.shared
            ? { usageRefresh: usageRefreshTrace }
            : {}),
          ...(modelCatalogRefreshTrace.background ||
          modelCatalogRefreshTrace.blocking ||
          modelCatalogRefreshTrace.shared
            ? { modelCatalogRefresh: modelCatalogRefreshTrace }
            : {}),
          ...(accountPreparationTrace.skipped ||
          accountPreparationTrace.asynchronous
            ? { accountPreparation: accountPreparationTrace }
            : {}),
          accountSelection,
          ...(compactionItemCount
            ? {
                inputContext: {
                  compactionItemCount,
                  itemsBeforeLatestCompaction: latestCompactionIndex,
                },
              }
            : {}),
          ...(routingRequest
            ? {
                priority: routingRequest.priority,
                routingDecision: executionLocation,
                routingRule: policyDecision?.rule?.id,
                routingScores: policyDecision?.candidates.map((entry) => ({
                  model: entry.config.model,
                  accountId: entry.resource.accountId,
                  score: entry.score,
                  rejectedReasons: entry.rejectedReasons,
                })),
                admissionWaitMs: Date.now() - startedAt,
                executionLocation,
                capacityVersion: capacityTracker?.getVersion(),
              }
            : {}),
        };
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
          candidate.provider === "opencode"
            ? selected.opencodeApiKey ?? selected.accessToken
            : selected.accessToken,
          {
            model: candidate.resolvedModel,
            conversationId: sessionId,
            opencodeHeaders: selected.opencodeHeaders,
          },
        );
        if (candidate.provider === "openai") {
          headers["OpenAI-Beta"] = "responses=experimental";
        }
        if (candidate.provider === "openai" && selected.chatgptAccountId) {
          headers["chatgpt-account-id"] = selected.chatgptAccountId;
        }
        if (sessionId) headers.session_id = sessionId;

        if (capacityTracker && candidate.resolvedModel) {
          attemptCapacityLease ??= capacityTracker.acquire(
            selected.id,
            candidate.resolvedModel,
          );
          res.locals.multivibeCapacityLeaseClaimed = true;
          currentCapacityObservation = {};
        }

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
          } else if (
            candidate.provider === "openai-compatible" ||
            candidate.provider === "opencode"
          ) {
            upstreamPath = shouldSendChatCompletions
              ? "/v1/chat/completions"
              : "/v1/responses";
          } else if (candidate.provider === "xai") {
            upstreamPath = shouldSendChatCompletions
              ? XAI_CHAT_COMPLETIONS_PATH
              : XAI_RESPONSES_PATH;
          } else if (candidate.provider === "zai") {
            upstreamBaseUrl = zaiBaseUrl;
            upstreamPath = isResponsesCompactPath
              ? zaiCompactUpstreamPath
              : zaiUpstreamPath;
          }
          if (
            !shouldReturnChatCompletions &&
            clientRequestedStream &&
            !nativeStreamTraceId
          ) {
            nativeStreamTraceId = await nativeStreamTracePromise!;
          }
          const upstreamStartedAt = Date.now();
          latencyBreakdown.preparationMs = upstreamStartedAt - startedAt;
          let upstream = await fetchUpstreamWithRetry(
            `${upstreamBaseUrl}${upstreamPath}`,
            {
              method: "POST",
              headers,
              body: serializeUpstreamPayload(payloadToUpstream),
              signal: requestSignal,
            },
          );
          if (upstream.status === 400) {
            const errorText = await upstream.text();
            const correction = applyUnsupportedValueCorrection(
              payloadToUpstream,
              errorText,
            );
            if (correction) {
              console.info(
                `[proxy] Retrying ${candidate.resolvedModel ?? "model"} after correcting unsupported value ${correction.from} -> ${correction.to}`,
              );
              upstream = await fetchUpstreamWithRetry(
                `${upstreamBaseUrl}${upstreamPath}`,
                {
                  method: "POST",
                  headers,
                  body: serializeUpstreamPayload(payloadToUpstream),
                  signal: requestSignal,
                },
              );
            } else {
              upstream = new Response(errorText, {
                status: upstream.status,
                statusText: upstream.statusText,
                headers: upstream.headers,
              });
            }
          }
          latencyBreakdown.upstreamHeadersMs =
            Date.now() - upstreamStartedAt;

          const contentType = upstream.headers.get("content-type") ?? "";
          const isStream = isStreamingUpstreamResponse(
            contentType,
            clientRequestedStream,
            upstream.ok,
            candidate.provider,
            Boolean(upstream.body),
          );

          // Native Responses streaming commits the client headers before the
          // upstream status is known. Convert upstream errors to SSE instead
          // of attempting to send a JSON response after headers are sent.
          if (isNativeResponsesStream && !upstream.ok) {
            const upstreamText = await upstream.text();
            let errorPayload: any = upstreamText;
            try {
              errorPayload = upstreamText ? JSON.parse(upstreamText) : undefined;
            } catch {
              // Keep the upstream text as the diagnostic message below.
            }
            const upstreamError =
              errorPayload?.error ??
              ({
                message: upstreamText || `Upstream returned HTTP ${upstream.status}`,
                type: "upstream_error",
                code: "upstream_error",
              } as const);

            if (
              upstream.status === 402 ||
              upstream.status === 429 ||
              isQuotaErrorText(upstreamText)
            ) {
              markQuotaHit(
                selected,
                blockModel,
                `quota/rate-limit: ${upstream.status}`,
                upstreamText,
              );
              await store.upsertAccount(selected);

              const traceId =
                nativeStreamTraceId ?? (await nativeStreamTracePromise!);
              await completeTrace(traceId, {
                at: Date.now(),
                startedAt,
                route: req.path,
                accountId: selected.id,
                accountEmail: selected.email,
                model: tracedModel,
                ...traceModelResolution,
                status: upstream.status,
                stream: true,
                latencyMs: Date.now() - startedAt,
                requestBody,
                error:
                  typeof upstreamError?.message === "string"
                    ? upstreamError.message
                    : `Upstream returned HTTP ${upstream.status}`,
                upstreamContentType: contentType,
                lifecycleState: "completed",
              });

              // Start a fresh trace for the next account attempt while keeping
              // the already-committed client SSE connection alive.
              nativeStreamTraceId = undefined;
              nativeStreamTracePromise = startNativeStreamTrace();
              continue;
            }

            if (!res.writableEnded) {
              res.write(
                `event: error\ndata: ${JSON.stringify({ error: upstreamError })}\n\n`,
              );
              res.write(
                responseObjectToSSE({
                  id: `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
                  object: "response",
                  created_at: Math.floor(Date.now() / 1000),
                  model: tracedModel,
                  status: "failed",
                  error: upstreamError,
                  output: [],
                }),
              );
              res.end();
            }
            const traceId = await nativeStreamTracePromise!;
            await completeTrace(traceId, {
              at: Date.now(),
              startedAt,
              route: req.path,
              accountId: selected.id,
              accountEmail: selected.email,
              model: tracedModel,
              ...traceModelResolution,
              status: upstream.status,
              stream: true,
              latencyMs: Date.now() - startedAt,
              requestBody,
              error:
                typeof upstreamError?.message === "string"
                  ? upstreamError.message
                  : `Upstream returned HTTP ${upstream.status}`,
              upstreamContentType: contentType,
              lifecycleState: "completed",
            });
            return;
          }

          if (isStream) {
            if (!shouldReturnChatCompletions && clientRequestedStream && upstream.body) {
              const streamTraceId = nativeStreamTraceId!;

              const reader = upstream.body.getReader();
              const diagnostics = createResponseStreamDiagnostics();
              const chatStreamState = shouldSendChatCompletions
                ? createChatStreamAccumulator(
                    req.body?.model ?? payloadToUpstream?.model ?? "unknown",
                  )
                : undefined;
              const decoder = chatStreamState ? new TextDecoder() : undefined;
              let sseBuffer = "";
              let usage: any = undefined;
              let clientDisconnected = false;
              let streamError: Error | undefined;
              const abortOnDisconnect = () => {
                clientDisconnected = !res.writableEnded;
                if (clientDisconnected) {
                  void reader.cancel().catch(() => undefined);
                }
              };
              res.once("close", abortOnDisconnect);
              const streamTap = createSSEStreamTap((frame) => {
                usage =
                  inspectResponseStreamFrame(frame, diagnostics) ?? usage;
                if (!chatStreamState) markFirstOutput(frame);
              });
              const forwardChatCompletionFrame = (frame: string) => {
                streamTap.push(new TextEncoder().encode(frame));
                const converted = convertChatCompletionSSEToResponseSSE(
                  frame,
                  chatStreamState!,
                );
                if (converted && !res.writableEnded) {
                  res.write(converted);
                  markFirstOutput(frame);
                }
              };

              try {
                while (!clientDisconnected) {
                  const { value, done } = await reader.read();
                  if (done) break;
                  if (chatStreamState) {
                    sseBuffer += decoder!.decode(value, { stream: true });
                    while (true) {
                      const next = takeNextSSEFrame(sseBuffer);
                      if (!next) break;
                      sseBuffer = next.rest;
                      forwardChatCompletionFrame(next.frame);
                    }
                  } else {
                    if (!res.writableEnded) res.write(value);
                    streamTap.push(value);
                  }
                }
                if (!clientDisconnected) {
                  if (chatStreamState) {
                    sseBuffer += decoder!.decode();
                    while (true) {
                      const next = takeNextSSEFrame(sseBuffer);
                      if (!next) break;
                      sseBuffer = next.rest;
                      forwardChatCompletionFrame(next.frame);
                    }
                    if (sseBuffer.trim()) {
                      forwardChatCompletionFrame(sseBuffer);
                    }
                    const completed =
                      finalizeChatCompletionSSEToResponseSSE(chatStreamState);
                    if (completed && !res.writableEnded) {
                      res.write(completed);
                      streamTap.push(new TextEncoder().encode(completed));
                    }
                    usage = chatStreamState.usage ?? usage;
                  }
                  const { unterminatedFrame } = streamTap.finish();
                  if (unterminatedFrame && !res.writableEnded) {
                    res.write("\n\n");
                  }
                }
              } catch (error: any) {
                streamError = error instanceof Error ? error : new Error(String(error));
              } finally {
                res.off("close", abortOnDisconnect);
                if (nativeStreamKeepalive) {
                  clearInterval(nativeStreamKeepalive);
                  nativeStreamKeepalive = undefined;
                }
              }

              const classification = classifyNativeStreamCompletion(
                clientDisconnected,
                diagnostics.sawResponseCompleted,
                streamError,
              );
              if (
                streamError &&
                !diagnostics.sawResponseCompleted &&
                !clientDisconnected &&
                !res.writableEnded
              ) {
                res.write(
                  `event: error\ndata: ${JSON.stringify({
                    error: {
                      message: streamError.message,
                      type: "upstream_error",
                      code: "stream_interrupted",
                    },
                  })}\n\n`,
                );
              }
              if (!clientDisconnected && !res.writableEnded) res.end();
              await completeTrace(streamTraceId, {
                at: Date.now(),
                startedAt,
                route: req.path,
                accountId: selected.id,
                accountEmail: selected.email,
                model: tracedModel,
                ...traceModelResolution,
                status:
                  classification.status === 200
                    ? upstream.status
                    : classification.status,
                stream: true,
                latencyMs: Date.now() - startedAt,
                usage,
                requestBody,
                ...traceImage,
                error: classification.error,
                upstreamContentType: contentType,
                responseStreamDiagnostics: diagnostics,
                clientDisconnected: classification.clientDisconnected,
                lifecycleState: classification.interrupted
                  ? "interrupted"
                  : "completed",
              });
              return;
            }

            if (shouldReturnChatCompletions && clientRequestedStream) {
              res.set("Content-Type", "text/event-stream");
              res.set("Cache-Control", "no-cache");
              res.set("Connection", "keep-alive");

              if (shouldSendChatCompletions) {
                if (!upstream.body) return res.end();
                const streamTraceId = await beginTrace({
                  at: startedAt,
                  startedAt,
                  route: req.path,
                  accountId: selected.id,
                  accountEmail: selected.email,
                  model: tracedModel,
                  ...traceModelResolution,
                  status: 102,
                  stream: true,
                  latencyMs: 0,
                  requestBody,
                  ...traceImage,
                  upstreamContentType: contentType,
                });
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
                  if (clientDisconnected) {
                    void reader.cancel().catch(() => undefined);
                  }
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
                  markFirstOutput(frame);
                  if (frame.includes("[DONE]")) doneSent = true;
                  accumulatedUsage =
                    extractSSEFrameUsage(frame) ?? accumulatedUsage;
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

                if (clientDisconnected) {
                  await completeTrace(streamTraceId, {
                    at: Date.now(),
                    startedAt,
                    route: req.path,
                    accountId: selected.id,
                    accountEmail: selected.email,
                    model: tracedModel,
                    ...traceModelResolution,
                    status: 499,
                    stream: true,
                    latencyMs: Date.now() - startedAt,
                    usage: accumulatedUsage,
                    requestBody,
                    ...traceImage,
                    error: "client disconnected before stream completion",
                    upstreamContentType: contentType,
                    clientDisconnected: true,
                    lifecycleState: "interrupted",
                  });
                  return;
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

                await completeTrace(streamTraceId, {
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
              const streamTraceId = await beginTrace({
                at: startedAt,
                startedAt,
                route: req.path,
                accountId: selected.id,
                accountEmail: selected.email,
                model: tracedModel,
                ...traceModelResolution,
                status: 102,
                stream: true,
                latencyMs: 0,
                requestBody,
                ...traceImage,
                upstreamContentType: contentType,
              });
              const decoder = new TextDecoder();
              const streamState =
                createResponsesToChatCompletionStreamState(model);
              let sseBuffer = "";
              let clientDisconnected = false;
              let streamError: Error | undefined;
              const abortOnDisconnect = () => {
                clientDisconnected = !res.writableEnded;
                if (clientDisconnected) {
                  void reader.cancel().catch(() => undefined);
                }
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
                  markFirstOutput(frame);
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

              if (clientDisconnected) {
                await completeTrace(streamTraceId, {
                  at: Date.now(),
                  startedAt,
                  route: req.path,
                  accountId: selected.id,
                  accountEmail: selected.email,
                  model: tracedModel,
                  ...traceModelResolution,
                  status: 499,
                  stream: true,
                  latencyMs: Date.now() - startedAt,
                  usage: streamState.usage,
                  requestBody,
                  ...traceImage,
                  error: "client disconnected before stream completion",
                  upstreamContentType: contentType,
                  responseStreamDiagnostics: streamStateDiagnostics,
                  clientDisconnected: true,
                  lifecycleState: "interrupted",
                });
                return;
              }

              const completed =
                finalizeResponsesSSEToChatCompletionSSE(streamState);
              if (completed && !res.writableEnded) res.write(completed);

              if (streamError && !streamState.assistantOutputSent) {
                rememberError(selected, streamError.message);
                await store.upsertAccount(selected);
                await completeTrace(streamTraceId, {
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
                await completeTrace(streamTraceId, {
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

              await completeTrace(streamTraceId, {
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

          if (upstream.ok) {
            res.status(upstream.status);
            setForwardHeaders(upstream, res);
            res.type(contentType || "application/json").send(text);
            return;
          }

          if (upstream.status === 401 && candidate.provider === "xai") {
            const staleToken = selected.accessToken;
            const expired: Account = {
              ...selected,
              expiresAt: 1,
              state: {
                ...selected.state,
                needsTokenRefresh: true,
              },
            };
            const refreshed = await ensureValidToken(expired, oauthConfig);
            Object.assign(selected, refreshed);
            await store.upsertAccount(selected);
            if (refreshed.accessToken !== staleToken) {
              tried.delete(selected.id);
              i -= 1;
              continue;
            }
            selected.state = {
              ...selected.state,
              authBlockedUntil: Date.now() + 60_000,
            };
            rememberError(selected, "xAI rejected the subscription credential");
            await store.upsertAccount(selected);
            continue;
          }

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

          if (
            upstream.status === 402 ||
            upstream.status === 429 ||
            isQuotaErrorText(text)
          ) {
            markQuotaHit(
              selected,
              blockModel,
              `quota/rate-limit: ${upstream.status}`,
              text,
            );
            await store.upsertAccount(selected);
            continue;
          }

          res.status(upstream.status);
          setForwardHeaders(upstream, res);
          res.type(contentType || "application/json").send(text);
          rememberError(
            selected,
            `upstream ${upstream.status}: ${text.slice(0, 200)}`,
          );
          await store.upsertAccount(selected);
          return;
        } catch (err: any) {
          if (requestSignal.aborted) {
            if (nativeStreamKeepalive) {
              clearInterval(nativeStreamKeepalive);
              nativeStreamKeepalive = undefined;
            }
            if (isNativeResponsesStream) {
              const traceId =
                nativeStreamTraceId ??
                (nativeStreamTracePromise
                  ? await nativeStreamTracePromise
                  : undefined);
              if (traceId) {
                try {
                  await completeTrace(traceId, {
                    at: Date.now(),
                    startedAt,
                    route: req.path,
                    accountId: selected.id,
                    accountEmail: selected.email,
                    model: tracedModel,
                    ...traceModelResolution,
                    status: 499,
                    stream: true,
                    latencyMs: Date.now() - startedAt,
                    error: "client disconnected before upstream completion",
                    requestBody,
                    ...traceImage,
                    lifecycleState: "interrupted",
                  });
                } catch (traceError) {
                  console.error("failed to record client disconnect", traceError);
                }
              }
            } else {
              try {
                recordTrace({
                  at: Date.now(),
                  route: req.path,
                  accountId: selected.id,
                  accountEmail: selected.email,
                  model: tracedModel,
                  ...traceModelResolution,
                  status: 499,
                  stream: false,
                  latencyMs: Date.now() - startedAt,
                  error: "client disconnected before upstream completion",
                  requestBody,
                  ...traceImage,
                });
              } catch (traceError) {
                console.error("failed to record client disconnect", traceError);
              }
            }
            return;
          }
          const msg = err?.message ?? String(err);
          rememberError(selected, msg);
          if (nativeStreamKeepalive) {
            clearInterval(nativeStreamKeepalive);
            nativeStreamKeepalive = undefined;
          }
          if (isNativeResponsesStream && res.headersSent && !res.writableEnded) {
            res.write(
              `event: error\ndata: ${JSON.stringify({
                error: {
                  message: msg,
                  type: "upstream_error",
                  code: "stream_interrupted",
                },
              })}\n\n`,
            );
            res.end();
          }
          await store.upsertAccount(selected).catch((persistError) => {
            console.error("failed to persist upstream stream error", persistError);
          });
          try {
            if (nativeStreamTraceId) {
              await completeTrace(nativeStreamTraceId, {
                at: Date.now(),
                startedAt,
                route: req.path,
                accountId: selected.id,
                accountEmail: selected.email,
                model: tracedModel,
                ...traceModelResolution,
                status: 599,
                stream: true,
                latencyMs: Date.now() - startedAt,
                error: msg,
                requestBody,
                ...traceImage,
                lifecycleState: "interrupted",
              });
            } else recordTrace({
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
          } catch (traceError) {
            console.error("failed to record upstream stream error", traceError);
          }
          if (res.headersSent) return;
        } finally {
          if (attemptCapacityLease) {
            attemptCapacityLease.release({
              latencyMs: Date.now() - attemptCapacityLease.startedAt,
              ...currentCapacityObservation,
            });
            if (attemptCapacityLease === reservedCapacityLease) {
              reservationReleased = true;
            }
          }
          currentCapacityObservation = undefined;
        }
      }
    }
    if (!providerTried) {
      return sendPreparationError(
        503,
        "no provider accounts configured for requested model",
      );
    }
    if (res.headersSent && !isNativeResponsesStream) return;

    const elapsed = Date.now() - hangStart;
    if (elapsed >= HANG_RETRY_MAX_DURATION_MS) break; // fall through to final error response

    // Wait before retrying: some accounts may have had their rate-limit blocks expire
    if (!(await waitForHangRetry(HANG_RETRY_INTERVAL_MS, requestSignal))) return;
    // Reload accounts from store to pick up any blocks that expired
    accounts = store.getCachedAccounts();
    // sawEmptyAssistantOutput is preserved across retries
    }

    // Max hang duration exceeded — all accounts still exhausted
    if (sawEmptyAssistantOutput) {
      return sendPreparationError(502, {
        message:
          "Upstream returned no assistant output after retrying all eligible accounts.",
        type: "upstream_error",
        code: "empty_assistant_output",
      });
    }
    return sendPreparationError(429, "all accounts exhausted or unavailable");
  }
  function setForwardHeaders(from: Response, to: express.Response) {
    for (const [k, v] of from.headers.entries())
      if (shouldForwardDecodedResponseHeader(k)) to.setHeader(k, v);
  }

  function requestHeadersForPassthrough(
    req: express.Request,
    account: { accessToken: string; chatgptAccountId?: string },
  ): Record<string, string> {
    const forwarded: Record<string, string> = {};
    const originalHeaders = req.originalHeadersForPassthrough ?? req.headers;

    for (const [rawName, rawValue] of Object.entries(originalHeaders)) {
      const name = rawName.toLowerCase();
      if (
        isHopByHopHeader(name) ||
        name === "authorization" ||
        name === TRACE_HEADERS_FORWARD_HEADER
      )
        continue;
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
  router.all("/messages", rejectNonPost("/v1/messages"));
  router.post("/messages", (req, res, next) => {
    res.locals._multivibeTraced = true;
    handleAnthropicMessages(req, res).catch(next);
  });

  async function listExposedModels() {
    return discoverModels(store, openaiBaseUrl, mistralBaseUrl, zaiBaseUrl);
  }

  router.get(["/models", "/api/v1/models"], async (req, res) => {
    if (isClaudeCodeRequest(req.headers)) {
      return res.json(buildClaudeCodeModelsResponse());
    }
    const models = await listExposedModels();
    res.json(buildModelsListResponse(models));
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
