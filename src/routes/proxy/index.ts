import express from "express";
import { AccountStore } from "../../store.js";
import { TraceManager } from "../../traces.js";
import {
  sanitizeAssistantTextChunk,
  ensureNonEmptyChatCompletion,
  sanitizeResponsesSSEFrame,
} from "../../responses/sanitizers.js";
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
  normalizeResponsesPayload,
  extractUsageFromPayload,
  inspectAssistantPayload,
  getSessionId,
} from "../../responses/payloads.js";
import {
  chooseAccount,
  isQuotaErrorText,
  markQuotaHit,
  refreshUsageIfNeeded,
  rememberError,
} from "../../quota.js";
import { ensureValidToken } from "../../account-utils.js";
import {
  CHATGPT_BASE_URL,
  MAX_ACCOUNT_RETRY_ATTEMPTS,
  MAX_UPSTREAM_RETRIES,
  MODELS_CACHE_MS,
  MODELS_CLIENT_VERSION,
  PI_USER_AGENT,
  PROXY_MODELS,
  TRACE_INCLUDE_BODY,
  UPSTREAM_BASE_DELAY_MS,
  UPSTREAM_PATH,
} from "../../config.js";
import type { OAuthConfig } from "../../oauth.js";

type ProxyRoutesOptions = {
  store: AccountStore;
  traceManager: TraceManager;
  chatgptBaseUrl: string;
  oauthConfig: OAuthConfig;
};

const modelsCache: { at: number; models: ExposedModel[] } = { at: 0, models: [] };

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

async function discoverModels(
  store: AccountStore,
  chatgptBaseUrl: string,
): Promise<ExposedModel[]> {
  if (Date.now() - modelsCache.at < MODELS_CACHE_MS && modelsCache.models.length)
    return modelsCache.models;

  try {
    const accounts = await store.listAccounts();
    const usable = accounts.find((a) => a.enabled && a.accessToken);
    if (!usable) throw new Error("no usable account");

    const headers: Record<string, string> = {
      authorization: `Bearer ${usable.accessToken}`,
      accept: "application/json",
    };
    if (usable.chatgptAccountId)
      headers["ChatGPT-Account-Id"] = usable.chatgptAccountId;

    const url = `${chatgptBaseUrl}/backend-api/codex/models?client_version=${encodeURIComponent(
      MODELS_CLIENT_VERSION,
    )}`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`models upstream ${r.status}`);
    const json: any = await r.json();
    const upstream = Array.isArray(json?.models) ? json.models : [];
    const byId = new Map<string, ExposedModel>();

    for (const entry of upstream) {
      const slug =
        typeof entry?.slug === "string" && entry.slug.trim()
          ? entry.slug.trim()
          : "";
      if (!slug) continue;
      byId.set(slug, modelObject(slug, entry));
    }
    for (const id of PROXY_MODELS) {
      if (!byId.has(id)) byId.set(id, modelObject(id));
    }

    const merged = Array.from(byId.values());
    modelsCache.at = Date.now();
    modelsCache.models = merged;
    return merged;
  } catch {
    const fallback = Array.from(new Set(PROXY_MODELS)).map((id) =>
      modelObject(id),
    );
    modelsCache.at = Date.now();
    modelsCache.models = fallback;
    return fallback;
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableUpstreamError(
  status: number,
  errorText: string,
): boolean {
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
        await sleep(UPSTREAM_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      return response;
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (
        attempt < MAX_UPSTREAM_RETRIES &&
        !lastError.message.includes("usage limit")
      ) {
        await sleep(UPSTREAM_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error("failed after retries");
}

export function createProxyRouter(options: ProxyRoutesOptions) {
  const { store, traceManager, chatgptBaseUrl, oauthConfig } = options;
  const { appendTrace } = traceManager;
  const router = express.Router();

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
    const clientRequestedStream = Boolean(req.body?.stream);
    const sessionId = getSessionId(req);

    let accounts = await store.listAccounts();
    if (!accounts.length)
      return res.status(503).json({ error: "no accounts configured" });

    accounts = await Promise.all(
      accounts.map(async (account) => {
        const valid = await ensureValidToken(account, oauthConfig);
        await refreshUsageIfNeeded(valid, chatgptBaseUrl);
        return valid;
      }),
    );
    await Promise.all(accounts.map((account) => store.upsertAccount(account)));

    const tried = new Set<string>();
    const maxAttempts = Math.min(accounts.length, MAX_ACCOUNT_RETRY_ATTEMPTS);
    for (let i = 0; i < maxAttempts; i++) {
      const selected = chooseAccount(accounts.filter((a) => !tried.has(a.id)));
      if (!selected) break;

      tried.add(selected.id);
      selected.state = { ...selected.state, lastSelectedAt: Date.now() };
      await store.upsertAccount(selected);

      const shouldReturnChatCompletions = isChatCompletionsPath;
      const payloadToUpstream = isChatCompletions
        ? chatCompletionsToResponsesPayload(req.body, sessionId)
        : normalizeResponsesPayload(req.body, sessionId);
      const requestBody = TRACE_INCLUDE_BODY ? req.body : undefined;
      const requestModel =
        typeof req.body?.model === "string" && req.body.model.trim()
          ? req.body.model.trim()
          : typeof payloadToUpstream?.model === "string" &&
              payloadToUpstream.model.trim()
            ? payloadToUpstream.model.trim()
            : undefined;

      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${selected.accessToken}`,
        accept: "text/event-stream",
        "OpenAI-Beta": "responses=experimental",
        originator: "pi",
        "User-Agent": PI_USER_AGENT,
      };
      if (selected.chatgptAccountId)
        headers["chatgpt-account-id"] = selected.chatgptAccountId;
      if (sessionId) headers.session_id = sessionId;

      try {
        const upstream = await fetchCodexWithRetry(
          `${chatgptBaseUrl}${UPSTREAM_PATH}`,
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

            const model =
              req.body?.model ?? payloadToUpstream?.model ?? "unknown";
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
          let accumulatedUsage: any = null;

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            sseBuffer += decoder.decode(value, { stream: true });

            while (true) {
              const next = takeNextSSEFrame(sseBuffer);
              if (!next) break;
              sseBuffer = next.rest;

              if (next.frame.includes("response.completed")) {
                try {
                  const dataLine = next.frame
                    .split(/\r?\n/)
                    .find((line) => line.trim().startsWith("data:"));
                  if (dataLine) {
                    const payload = JSON.parse(dataLine.slice(5).trim());
                    if (payload?.response?.usage) {
                      accumulatedUsage = payload.response.usage;
                    }
                  }
                } catch {}
              }

              const filtered = sanitizeResponsesSSEFrame(next.frame);
              if (filtered !== null) res.write(`${filtered}\n\n`);
            }
          }

          sseBuffer += decoder.decode();
          while (true) {
            const next = takeNextSSEFrame(sseBuffer);
            if (!next) break;
            sseBuffer = next.rest;

            if (next.frame.includes("response.completed")) {
              try {
                const dataLine = next.frame
                  .split(/\r?\n/)
                  .find((line) => line.trim().startsWith("data:"));
                if (dataLine) {
                  const payload = JSON.parse(dataLine.slice(5).trim());
                  if (payload?.response?.usage) {
                    accumulatedUsage = payload.response.usage;
                  }
                }
              } catch {}
            }

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
            usage: accumulatedUsage,
            requestBody,
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

          if (upstream.ok && parsed && parsed.object === "response") {
            const converted = responseObjectToChatCompletion(
              parsed,
              req.body?.model ?? payloadToUpstream?.model ?? "unknown",
            );
            res.status(200);
            res.set("Content-Type", "text.event-stream");
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

        if (shouldReturnChatCompletions && clientRequestedStream && upstream.ok) {
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

        if (!shouldReturnChatCompletions && clientRequestedStream && upstream.ok) {
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
              accountId: selected.id,
              accountEmail: selected.email,
              model: requestModel,
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
              accountId: selected.id,
              accountEmail: selected.email,
              model: requestModel,
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

  function setForwardHeaders(from: Response, to: express.Response) {
    for (const [k, v] of from.headers.entries())
      if (k.toLowerCase() !== "content-length") to.setHeader(k, v);
  }

  router.post("/chat/completions", proxyWithRotation);
  router.post("/responses", proxyWithRotation);

  router.get("/models", async (_req, res) => {
    const models = await discoverModels(store, chatgptBaseUrl);
    res.json({ object: "list", data: models });
  });

  router.get("/models/:id", async (req, res) => {
    const id = req.params.id;
    const models = await discoverModels(store, chatgptBaseUrl);
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
