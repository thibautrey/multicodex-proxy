import { createSSEStreamTap } from "./sse-stream-tap.js";

type WebsocketSSEMessageRelayOptions = {
  onMessage: (message: string) => void;
  onInspectableEvent: (event: unknown) => void;
};

export type WebsocketSSEMessageRelay = {
  push(chunk: Uint8Array): void;
  finish(): void;
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
    payload.includes('"type":"function_call"')
  );
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
  const tap = createSSEStreamTap((frame) => {
    const extracted = extractPayload(frame);
    if (!extracted) return;

    if (extracted.direct) {
      if (requiresInspection(extracted.payload)) {
        try {
          onInspectableEvent(JSON.parse(extracted.payload));
        } catch {
          return;
        }
      }
      onMessage(extracted.payload);
      return;
    }

    try {
      const parsed = JSON.parse(extracted.payload);
      onInspectableEvent(parsed);
      onMessage(JSON.stringify(parsed));
    } catch {
      // Match the previous relay behavior by ignoring malformed SSE payloads.
    }
  });

  return {
    push(chunk) {
      tap.push(chunk);
    },
    finish() {
      tap.finish();
    },
  };
}
