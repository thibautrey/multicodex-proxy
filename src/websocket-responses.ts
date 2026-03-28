import type http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

type InstallResponsesWebsocketProxyOptions = {
  server: http.Server;
  port: number;
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

function sendJson(ws: WebSocket, payload: unknown) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
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

function websocketRequestUrl(
  req: http.IncomingMessage,
  port: number,
  path: string,
) {
  const host = req.headers.host ?? `127.0.0.1:${port}`;
  return new URL(`http://${host}${path}`);
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

function sseFrameToJson(frame: string): unknown | null {
  const lines = frame
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const dataLines = lines.filter((line) => line.startsWith("data:"));
  if (!dataLines.length) return null;

  const payload = dataLines
    .map((line) => line.slice(5).trim())
    .join("\n")
    .trim();
  if (!payload || payload === "[DONE]") return null;

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function isValidAuthorizationHeader(value: string): boolean {
  const BearerPattern = /^Bearer\s+/i;
  if (!BearerPattern.test(value)) return false;
  const token = value.replace(BearerPattern, "");
  return token.length > 0 && /^[A-Za-z0-9_.-]+$/.test(token);
}

function takeNextSSEFrame(buffer: string): { frame: string; rest: string } | null {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const idx = normalized.indexOf("\n\n");
  if (idx === -1) return null;
  return {
    frame: normalized.slice(0, idx),
    rest: normalized.slice(idx + 2),
  };
}

async function relaySseAsWebsocket(ws: WebSocket, response: Response) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const next = takeNextSSEFrame(buffer);
      if (!next) break;
      buffer = next.rest;
      const payload = sseFrameToJson(next.frame);
      if (payload) sendJson(ws, payload);
    }
  }

  buffer += decoder.decode();
  while (true) {
    const next = takeNextSSEFrame(buffer);
    if (!next) break;
    buffer = next.rest;
    const payload = sseFrameToJson(next.frame);
    if (payload) sendJson(ws, payload);
  }
  if (buffer.trim()) {
    const payload = sseFrameToJson(buffer);
    if (payload) sendJson(ws, payload);
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
        conversationState.functionCalls.set(item.call_id, {
          call_id: item.call_id,
          name: item.name ?? "unknown",
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
        });
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

  let response: Response;
  try {
    response = await fetch(websocketRequestUrl(req, port, "/v1/responses"), {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamRequest),
    });
  } catch (error) {
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
    await relaySseAsWebsocket(ws, response);
    return;
  }

  await relayJsonAsWebsocket(ws, response, requestedModel);
}

export function installResponsesWebsocketProxy({
  server,
  port,
}: InstallResponsesWebsocketProxyOptions) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = req.url ? new URL(req.url, `http://${req.headers.host ?? "localhost"}`) : null;
    if (!url || url.pathname !== "/v1/responses") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    let inFlight = false;
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
        await forwardFrame(ws, req, port, frame, conversationState);
      } finally {
        inFlight = false;
      }
    });

    ws.on("error", () => {
      ws.close();
    });
  });
}
