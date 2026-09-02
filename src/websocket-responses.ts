import type http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { TRACE_INCLUDE_HEADERS } from "./config.js";
import { createWebsocketSSEMessageRelay } from "./responses/websocket-sse-relay.js";
import {
  serializeTraceHeaders,
  TRACE_HEADERS_FORWARD_HEADER,
} from "./trace-headers.js";
import {
  CODEX_PROJECT_HOST_FORWARD_HEADER,
  CODEX_PROJECT_ROOT_FORWARD_HEADER,
  CODEX_SESSION_FORWARD_HEADER,
  extractCodexProjectHost,
  extractCodexProjectRoot,
  extractCodexSessionId,
  LITELLM_KEY_ALIAS_HEADER,
} from "./codex-projects.js";

type InstallResponsesWebsocketProxyOptions = {
  server: http.Server;
  port: number;
  authorize?: (req: http.IncomingMessage) => boolean;
};

type FunctionCallRecord = {
  call_id: string;
  name: string;
  arguments: string;
};

type ConversationState = {
  functionCalls: Map<string, FunctionCallRecord>;
};

type ResponseCreateFrame = {
  type: "response.create";
  generate?: boolean;
  [key: string]: unknown;
};

type ErrorFrame = {
  type: "error";
  status?: number;
  error: {
    code?: string;
    message: string;
    type: string;
  };
};

function rememberFunctionCall(
  conversationState: ConversationState,
  item: any,
) {
  if (item?.type !== "function_call" || !item?.call_id) return;
  conversationState.functionCalls.set(item.call_id, {
    call_id: item.call_id,
    name: item.name ?? "unknown",
    arguments:
      typeof item.arguments === "string"
        ? item.arguments
        : JSON.stringify(item.arguments ?? {}),
  });
}

function rememberFunctionCallsFromResponse(
  conversationState: ConversationState,
  response: any,
) {
  const output = Array.isArray(response?.output) ? response.output : [];
  for (const item of output) rememberFunctionCall(conversationState, item);
}

function rememberFunctionCallsFromEvent(
  conversationState: ConversationState,
  event: any,
) {
  if (!event || typeof event !== "object") return;

  if (
    event.type === "response.output_item.added" ||
    event.type === "response.output_item.done"
  ) {
    rememberFunctionCall(conversationState, event.item);
    return;
  }

  if (event.type === "response.completed") {
    rememberFunctionCallsFromResponse(conversationState, event.response);
  }
}

function sendJson(ws: WebSocket, payload: unknown) {
  return sendText(ws, JSON.stringify(payload));
}

function sendText(ws: WebSocket, payload: string) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(payload);
    return true;
  } catch {
    return false;
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export const WEBSOCKET_MAX_PENDING_DELIVERY_BYTES = 8 * 1024 * 1024;
export const WEBSOCKET_MAX_BUFFERED_AMOUNT_BYTES = 8 * 1024 * 1024;
export const WEBSOCKET_MAX_PENDING_DELIVERIES = 4_096;
export const WEBSOCKET_DELIVERY_TIMEOUT_MS = 30_000;

type WebSocketDeliveryTarget = Pick<
  WebSocket,
  "readyState" | "bufferedAmount" | "send" | "terminate"
>;

export type WebSocketDeliveryQueueOptions = {
  deliveryTimeoutMs?: number;
  maxBufferedAmountBytes?: number;
  maxPendingBytes?: number;
  maxPendingDeliveries?: number;
  signal?: AbortSignal;
};

type PendingWebSocketDelivery = {
  bytes: number;
  promise: Promise<void>;
  reject: (error: Error) => void;
  resolve: () => void;
  timeout?: NodeJS.Timeout;
};

export class WebSocketDeliveryQueue {
  private readonly pending = new Set<PendingWebSocketDelivery>();
  private readonly deliveryTimeoutMs: number;
  private readonly maxBufferedAmountBytes: number;
  private readonly maxPendingBytes: number;
  private readonly maxPendingDeliveries: number;
  private readonly signal?: AbortSignal;
  private readonly abortListener: () => void;
  private failure: Error | null = null;
  private pendingBytes = 0;

  constructor(
    private readonly ws: WebSocketDeliveryTarget,
    private readonly onFailure: (error: Error) => void,
    options: WebSocketDeliveryQueueOptions = {},
  ) {
    this.deliveryTimeoutMs =
      options.deliveryTimeoutMs ?? WEBSOCKET_DELIVERY_TIMEOUT_MS;
    this.maxBufferedAmountBytes =
      options.maxBufferedAmountBytes ?? WEBSOCKET_MAX_BUFFERED_AMOUNT_BYTES;
    this.maxPendingBytes =
      options.maxPendingBytes ?? WEBSOCKET_MAX_PENDING_DELIVERY_BYTES;
    this.maxPendingDeliveries =
      options.maxPendingDeliveries ?? WEBSOCKET_MAX_PENDING_DELIVERIES;
    this.signal = options.signal;
    this.abortListener = () => {
      this.fail(
        this.signal?.reason ?? new Error("websocket delivery aborted"),
        false,
      );
    };

    if (this.signal?.aborted) this.abortListener();
    else this.signal?.addEventListener("abort", this.abortListener, {
      once: true,
    });
  }

  send(payload: string) {
    if (this.failure) throw this.failure;
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw this.fail(
        new Error("websocket closed before the upstream event was delivered"),
        false,
      );
    }

    const payloadBytes = Buffer.byteLength(payload);
    if (
      this.pending.size >= this.maxPendingDeliveries ||
      this.pendingBytes + payloadBytes > this.maxPendingBytes
    ) {
      throw this.fail(
        new Error(
          `websocket delivery backlog exceeded ${this.maxPendingBytes} bytes or ${this.maxPendingDeliveries} messages`,
        ),
        true,
      );
    }
    if (this.ws.bufferedAmount + payloadBytes > this.maxBufferedAmountBytes) {
      throw this.fail(
        new Error(
          `websocket buffered amount exceeded ${this.maxBufferedAmountBytes} bytes`,
        ),
        true,
      );
    }

    let resolveDelivery!: () => void;
    let rejectDelivery!: (error: Error) => void;
    const delivery = new Promise<void>((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });
    void delivery.catch(() => undefined);
    const pending: PendingWebSocketDelivery = {
      bytes: payloadBytes,
      promise: delivery,
      reject: rejectDelivery,
      resolve: resolveDelivery,
    };
    this.pending.add(pending);
    this.pendingBytes += payloadBytes;
    pending.timeout = setTimeout(() => {
      this.fail(
        new Error(
          `websocket delivery timed out after ${this.deliveryTimeoutMs}ms`,
        ),
        true,
      );
    }, this.deliveryTimeoutMs);

    try {
      this.ws.send(payload, (error) => {
        if (error) this.fail(error, true);
        else this.settle(pending);
      });
    } catch (error) {
      throw this.fail(error, true);
    }
  }

  async flush() {
    if (this.failure) throw this.failure;
    while (this.pending.size > 0) {
      await Promise.allSettled(
        [...this.pending].map((delivery) => delivery.promise),
      );
      if (this.failure) throw this.failure;
    }
  }

  dispose() {
    this.detachAbortListener();
    if (this.pending.size > 0 && !this.failure) {
      this.fail(new Error("websocket delivery queue disposed"), false);
    }
  }

  private settle(delivery: PendingWebSocketDelivery) {
    if (!this.pending.delete(delivery)) return;
    if (delivery.timeout) clearTimeout(delivery.timeout);
    this.pendingBytes -= delivery.bytes;
    delivery.resolve();
  }

  private fail(error: unknown, terminate: boolean) {
    if (this.failure) return this.failure;

    const failure = normalizeError(error);
    this.failure = failure;
    this.detachAbortListener();
    for (const delivery of [...this.pending]) {
      this.pending.delete(delivery);
      if (delivery.timeout) clearTimeout(delivery.timeout);
      this.pendingBytes -= delivery.bytes;
      delivery.reject(failure);
    }
    this.pendingBytes = 0;
    try {
      this.onFailure(failure);
    } catch {
      // Cleanup failures must not replace the delivery failure or skip close.
    }

    if (terminate && this.ws.readyState !== WebSocket.CLOSED) {
      try {
        this.ws.terminate();
      } catch {
        // The delivery failure is already recorded and propagated to flush().
      }
    }
    return failure;
  }

  private detachAbortListener() {
    this.signal?.removeEventListener("abort", this.abortListener);
  }
}

class UpstreamStreamInterruptedError extends Error {}

function upstreamStreamErrorMessage(error: unknown) {
  if (error instanceof UpstreamStreamInterruptedError) return error.message;
  const detail = normalizeError(error).message.trim().slice(0, 500);
  return detail
    ? `upstream stream interrupted: ${detail}`
    : "upstream stream interrupted";
}

function sendError(
  ws: WebSocket,
  message: string,
  status = 400,
  code = "invalid_request_error",
) {
  const payload: ErrorFrame = {
    type: "error",
    status,
    error: {
      code,
      type: code,
      message,
    },
  };
  sendJson(ws, payload);
}

function tryParseFrame(text: string): ResponseCreateFrame | null {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    if ((parsed as ResponseCreateFrame).type !== "response.create") return null;
    return parsed as ResponseCreateFrame;
  } catch {
    return null;
  }
}

export function websocketRequestUrl(
  _req: http.IncomingMessage,
  port: number,
  path: string,
) {
  // This request re-enters the same process. The outer Host header describes
  // the client-facing endpoint and may not resolve (or may resolve elsewhere)
  // from inside the container, so it must never be used as the loopback target.
  return new URL(`http://localhost:${port}${path}`);
}

function extractBodyText(body: string) {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    const msg =
      typeof parsed?.error?.message === "string"
        ? parsed.error.message
        : typeof parsed?.error === "string"
          ? parsed.error
          : undefined;
    return msg ?? body.slice(0, 500);
  } catch {
    return body.slice(0, 500);
  }
}

function makeWarmupResponse(frame: ResponseCreateFrame) {
  const responseId = `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const model =
    typeof frame.model === "string" && frame.model.trim()
      ? frame.model.trim()
      : "unknown";
  return {
    created: {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        model,
        status: "in_progress",
      },
    },
    completed: {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        model,
        status: "completed",
        output: [],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
        },
      },
    },
  };
}

function isValidAuthorizationHeader(value: string): boolean {
  return /^Bearer\s+\S+$/i.test(value);
}

async function relaySseAsWebsocket(
  ws: WebSocket,
  response: Response,
  conversationState: ConversationState,
  signal?: AbortSignal,
) {
  if (!response.body) {
    throw new UpstreamStreamInterruptedError(
      "upstream stream ended without a response body",
    );
  }
  const reader = response.body.getReader();
  const delivery = new WebSocketDeliveryQueue(
    ws,
    (error) => {
      void reader.cancel(error).catch(() => undefined);
    },
    { signal },
  );
  const relay = createWebsocketSSEMessageRelay({
    onMessage: (message) => delivery.send(message),
    onInspectableEvent: (event) =>
      rememberFunctionCallsFromEvent(conversationState, event),
  });
  const cancelReader = () => {
    void reader
      .cancel(signal?.reason ?? new Error("websocket closed"))
      .catch(() => undefined);
  };

  if (signal?.aborted) cancelReader();
  else signal?.addEventListener("abort", cancelReader, { once: true });

  let terminalEvent: string | null = null;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      terminalEvent = relay.push(value) ?? terminalEvent;
    }
    terminalEvent = relay.finish().terminalEvent ?? terminalEvent;
    await delivery.flush();
    if (!terminalEvent) {
      throw new UpstreamStreamInterruptedError(
        "upstream stream ended before a terminal response.completed, response.failed, response.incomplete, or error event",
      );
    }
  } catch (error) {
    if (terminalEvent) {
      try {
        await delivery.flush();
        return;
      } catch (deliveryError) {
        error = deliveryError;
      }
    }
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    delivery.dispose();
    reader.releaseLock();
  }
}

async function relayJsonAsWebsocket(
  ws: WebSocket,
  response: Response,
  requestedModel: string,
) {
  const body = await response.text();
  if (!response.ok) {
    sendError(
      ws,
      extractBodyText(body) ?? `unexpected status ${response.status}`,
      response.status,
    );
    return;
  }

  try {
    const parsed = JSON.parse(body);
    if (parsed?.object === "response" && typeof parsed?.id === "string") {
      sendJson(ws, {
        type: "response.created",
        response: {
          id: parsed.id,
          object: "response",
          model: parsed.model ?? requestedModel,
          status: parsed.status === "completed" ? "in_progress" : parsed.status,
        },
      });
      sendJson(ws, {
        type: "response.completed",
        response: parsed,
      });
      return;
    }

    sendError(ws, "upstream returned an unsupported non-stream response", 502);
  } catch {
    sendError(ws, extractBodyText(body) ?? "failed to parse upstream response", 502);
  }
}

async function forwardFrame(
  ws: WebSocket,
  req: http.IncomingMessage,
  port: number,
  frame: ResponseCreateFrame,
  conversationState: ConversationState,
  signal?: AbortSignal,
) {
  if (frame.generate === false) {
    const warmup = makeWarmupResponse(frame);
    sendJson(ws, warmup.created);
    sendJson(ws, warmup.completed);
    return;
  }

  const { type: _frameType, previous_response_id: _previousResponseId, ...frameBody } = frame;

  const input = Array.isArray(frameBody.input) ? frameBody.input : [];
  const existingCallIds = new Set<string>();
  const hasFunctionCalls = input.some((item: any) => item?.type === "function_call");
  const hasFunctionCallOutputs = input.some(
    (item: any) => item?.type === "function_call_output",
  );

  if (hasFunctionCalls) {
    for (const item of input) {
      if (item?.type === "function_call" && item?.call_id) {
        existingCallIds.add(item.call_id);
        rememberFunctionCall(conversationState, item);
      }
    }
  }

  if (hasFunctionCallOutputs && !hasFunctionCalls) {
    const enrichedInput: any[] = [];
    for (const item of input) {
      if (item?.type === "function_call_output" && item?.call_id && !existingCallIds.has(item.call_id)) {
        const matchedCall = conversationState.functionCalls.get(item.call_id);
        if (matchedCall) {
          enrichedInput.push({
            type: "function_call",
            call_id: matchedCall.call_id,
            name: matchedCall.name,
            arguments: matchedCall.arguments,
          });
        }
      }
      enrichedInput.push(item);
    }
    frameBody.input = enrichedInput;
  }

  const upstreamRequest = { ...frameBody, stream: true };
  const requestedModel =
    typeof frame.model === "string" && frame.model.trim()
      ? frame.model.trim()
      : "unknown";

  const headers = new Headers();
  const authHeader =
    typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  if (authHeader) {
    if (!isValidAuthorizationHeader(authHeader)) {
      sendError(ws, "Authorization header is badly formatted", 400, "invalid_request_error");
      return;
    }
    headers.set("authorization", authHeader);
  }
  const xApiKeyHeader =
    typeof req.headers["x-api-key"] === "string"
      ? req.headers["x-api-key"]
      : Array.isArray(req.headers["x-api-key"])
        ? req.headers["x-api-key"][0]
        : "";
  if (xApiKeyHeader) headers.set("x-api-key", xApiKeyHeader);
  for (const name of [
    "x-multivibe-priority",
    "x-multivibe-execution",
    "x-multivibe-max-wait-ms",
    "x-multivibe-deadline",
    "x-multivibe-idempotency-key",
    "x-multivibe-webhook",
  ]) {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string" && value) headers.set(name, value);
  }
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream");

  const openAiBetaHeader =
    typeof req.headers["openai-beta"] === "string"
      ? req.headers["openai-beta"]
      : Array.isArray(req.headers["openai-beta"])
        ? req.headers["openai-beta"].join(", ")
        : "";
  if (openAiBetaHeader) headers.set("openai-beta", openAiBetaHeader);

  const originator =
    typeof req.headers.originator === "string" ? req.headers.originator : "";
  if (originator) headers.set("originator", originator);

  const userAgent =
    typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "";
  if (userAgent) headers.set("user-agent", userAgent);

  const sessionIdHeader =
    typeof req.headers["session_id"] === "string"
      ? req.headers["session_id"]
      : typeof req.headers["session-id"] === "string"
        ? req.headers["session-id"]
        : typeof req.headers["x-session-id"] === "string"
          ? req.headers["x-session-id"]
          : "";
  if (sessionIdHeader) headers.set("session_id", sessionIdHeader);

  const turnState =
    typeof req.headers["x-codex-turn-state"] === "string"
      ? req.headers["x-codex-turn-state"]
      : "";
  if (turnState) headers.set("x-codex-turn-state", turnState);
  const codexSessionId = extractCodexSessionId(req.headers);
  if (codexSessionId) {
    headers.set(CODEX_SESSION_FORWARD_HEADER, codexSessionId);
  }
  const codexProjectRoot = extractCodexProjectRoot(req.headers);
  if (codexProjectRoot) {
    headers.set(CODEX_PROJECT_ROOT_FORWARD_HEADER, codexProjectRoot);
  }
  const codexProjectHost = extractCodexProjectHost(req.headers);
  if (codexProjectHost) {
    headers.set(CODEX_PROJECT_HOST_FORWARD_HEADER, codexProjectHost);
  }
  const rawLiteLLMKeyAlias = req.headers[LITELLM_KEY_ALIAS_HEADER];
  const liteLLMKeyAlias = Array.isArray(rawLiteLLMKeyAlias)
    ? rawLiteLLMKeyAlias.join(", ")
    : rawLiteLLMKeyAlias;
  if (liteLLMKeyAlias?.trim()) {
    headers.set(LITELLM_KEY_ALIAS_HEADER, liteLLMKeyAlias);
  }
  if (TRACE_INCLUDE_HEADERS) {
    headers.set(
      TRACE_HEADERS_FORWARD_HEADER,
      serializeTraceHeaders(req.headers),
    );
  }

  let response: Response;
  try {
    response = await fetch(websocketRequestUrl(req, port, "/v1/responses"), {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamRequest),
      signal,
    });
  } catch (error) {
    if (signal?.aborted || ws.readyState !== WebSocket.OPEN) return;
    sendError(
      ws,
      error instanceof Error ? error.message : String(error),
      502,
      "network_error",
    );
    return;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    sendError(
      ws,
      extractBodyText(body) ?? `unexpected status ${response.status}`,
      response.status,
      response.status === 429 ? "rate_limit_error" : "invalid_request_error",
    );
    return;
  }

  if (contentType.includes("text/event-stream")) {
    try {
      await relaySseAsWebsocket(ws, response, conversationState, signal);
    } catch (error) {
      if (!signal?.aborted && ws.readyState === WebSocket.OPEN) {
        sendError(
          ws,
          upstreamStreamErrorMessage(error),
          502,
          "upstream_stream_error",
        );
      }
    }
    return;
  }

  await relayJsonAsWebsocket(ws, response, requestedModel);
}

export function installResponsesWebsocketProxy({
  server,
  port,
  authorize,
}: InstallResponsesWebsocketProxyOptions) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = req.url ? new URL(req.url, `http://${req.headers.host ?? "localhost"}`) : null;
    if (!url || (url.pathname !== "/v1/responses" && url.pathname !== "/responses")) {
      socket.destroy();
      return;
    }
    if (authorize && !authorize(req)) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    let inFlight = false;
    const connectionAbort = new AbortController();
    const conversationState: ConversationState = {
      functionCalls: new Map(),
    };

    ws.on("message", async (message, isBinary) => {
      if (isBinary) {
        sendError(ws, "binary websocket frames are not supported", 400);
        return;
      }

      const frame = tryParseFrame(message.toString());
      if (!frame) {
        sendError(
          ws,
          "expected a JSON text frame with type='response.create'",
          400,
        );
        return;
      }

      if (inFlight) {
        sendError(
          ws,
          "a response is already in progress on this websocket",
          409,
          "response_already_in_progress",
        );
        return;
      }

      inFlight = true;
      try {
        await forwardFrame(
          ws,
          req,
          port,
          frame,
          conversationState,
          connectionAbort.signal,
        );
      } catch (error) {
        if (!connectionAbort.signal.aborted && ws.readyState === WebSocket.OPEN) {
          sendError(
            ws,
            normalizeError(error).message,
            502,
            "upstream_request_error",
          );
        }
      } finally {
        inFlight = false;
      }
    });

    ws.on("error", () => {
      connectionAbort.abort(new Error("websocket failed"));
      ws.close();
    });
    ws.once("close", () => {
      connectionAbort.abort(new Error("websocket closed"));
      conversationState.functionCalls.clear();
    });
  });
}
