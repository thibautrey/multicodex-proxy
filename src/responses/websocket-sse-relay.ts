import { createSSEStreamTap } from "./sse-stream-tap.js";

type WebsocketSSEMessageRelayOptions = {
  onMessage: (message: string) => void;
  onInspectableEvent: (event: unknown) => void;
};

export type WebsocketSSEMessageRelay = {
  push(chunk: Uint8Array): WebsocketSSETerminalEvent | null;
  finish(): WebsocketSSERelayResult;
};

export type WebsocketSSETerminalEvent =
  | "response.completed"
  | "response.failed"
  | "response.incomplete"
  | "error";

export type WebsocketSSERelayResult = {
  terminalEvent: WebsocketSSETerminalEvent | null;
  unterminatedFrame: boolean;
};

type ExtractedPayload = {
  payload: string;
  direct: boolean;
};

const directResponseEventPattern = /^\{"type":"response\.[^"\\]*"/;

function extractPayload(frame: string): ExtractedPayload | null {
  let payload = "";
  let dataLineCount = 0;
  let offset = 0;

  while (offset <= frame.length) {
    let end = frame.indexOf("\n", offset);
    if (end === -1) end = frame.length;
    let line = frame.slice(offset, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    line = line.trim();

    if (line.startsWith("data:")) {
      const data = line.slice(5).trim();
      payload += dataLineCount === 0 ? data : `\n${data}`;
      dataLineCount += 1;
    }

    if (end === frame.length) break;
    offset = end + 1;
  }

  payload = payload.trim();
  if (!payload || payload === "[DONE]") return null;

  return {
    payload,
    direct:
      dataLineCount === 1 &&
      directResponseEventPattern.test(payload) &&
      payload.endsWith("}"),
  };
}

function requiresInspection(payload: string) {
  return (
    payload.startsWith('{"type":"response.output_item.added"') ||
    payload.startsWith('{"type":"response.output_item.done"') ||
    payload.startsWith('{"type":"response.completed"') ||
    payload.startsWith('{"type":"response.failed"') ||
    payload.startsWith('{"type":"response.incomplete"') ||
    payload.includes('"type":"function_call"')
  );
}

function terminalEventType(event: unknown): WebsocketSSETerminalEvent | null {
  if (!event || typeof event !== "object") return null;
  const type = (event as { type?: unknown }).type;
  if (
    type === "response.completed" ||
    type === "response.failed" ||
    type === "response.incomplete" ||
    type === "error"
  ) {
    return type;
  }
  return null;
}

/**
 * Converts an upstream Responses SSE stream into WebSocket text messages.
 *
 * Successful Responses streams use compact, one-line JSON with `type` first.
 * Those events can be relayed byte-for-byte. Atypical frames retain the former
 * parse/stringify behavior, and malformed payloads are ignored.
 */
export function createWebsocketSSEMessageRelay({
  onMessage,
  onInspectableEvent,
}: WebsocketSSEMessageRelayOptions): WebsocketSSEMessageRelay {
  let terminalEvent: WebsocketSSETerminalEvent | null = null;
  const tap = createSSEStreamTap((frame) => {
    const extracted = extractPayload(frame);
    if (!extracted) return;

    if (extracted.direct) {
      if (requiresInspection(extracted.payload)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(extracted.payload);
        } catch {
          return;
        }
        terminalEvent ??= terminalEventType(parsed);
        onInspectableEvent(parsed);
      }
      onMessage(extracted.payload);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extracted.payload);
    } catch {
      // Match the previous relay behavior by ignoring malformed SSE payloads.
      return;
    }
    terminalEvent ??= terminalEventType(parsed);
    onInspectableEvent(parsed);
    onMessage(JSON.stringify(parsed));
  });

  return {
    push(chunk) {
      tap.push(chunk);
      return terminalEvent;
    },
    finish() {
      const { unterminatedFrame } = tap.finish();
      return { terminalEvent, unterminatedFrame };
    },
  };
}
