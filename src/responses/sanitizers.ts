import { EMPTY_ASSISTANT_FALLBACK_TEXT } from "./helpers.js";
import {
  asNonEmptyString,
  sanitizeOutputText,
  shouldExposeFunctionCallName,
  toUpstreamInputContent,
  toolContentToOutput,
  isVisibleAssistantContentPart,
} from "./helpers.js";

type SanitizedEventResult =
  | { drop: true; event: null; changed: boolean }
  | { drop: false; event: any; changed: boolean };

export function sanitizeAssistantTextChunk(text: string): string {
  return sanitizeOutputText(text);
}

function hasContentOrToolCalls(choice: any): boolean {
  const content = choice?.message?.content;
  const contentText =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part: any) =>
              typeof part?.text === "string" ? part.text : "",
            )
            .join("")
        : "";
  const hasText = Boolean(asNonEmptyString(contentText));
  const hasToolCalls =
    Array.isArray(choice?.message?.tool_calls) &&
    choice.message.tool_calls.length > 0;
  return hasText || hasToolCalls;
}

export function withFallbackAssistantContent(chat: any, fallbackText: string) {
  const safeFallback = asNonEmptyString(sanitizeOutputText(fallbackText));
  if (!safeFallback) return chat;
  if (!chat || typeof chat !== "object" || chat.object !== "chat.completion")
    return chat;
  const choice = chat?.choices?.[0];
  if (!choice) return chat;
  if (hasContentOrToolCalls(choice)) return chat;

  return {
    ...chat,
    choices: [
      {
        ...choice,
        message: {
          ...(choice?.message ?? {}),
          content: safeFallback,
        },
      },
      ...(Array.isArray(chat?.choices) ? chat.choices.slice(1) : []),
    ],
  };
}

export function ensureNonEmptyChatCompletion(chat: any): {
  chat: any;
  patched: boolean;
} {
  if (!chat || typeof chat !== "object" || chat.object !== "chat.completion")
    return { chat, patched: false };
  const choice = chat?.choices?.[0];
  if (!choice) return { chat, patched: false };
  if (hasContentOrToolCalls(choice)) return { chat, patched: false };

  const patched = {
    ...chat,
    choices: [
      {
        ...choice,
        message: {
          ...(choice?.message ?? {}),
          content: EMPTY_ASSISTANT_FALLBACK_TEXT,
        },
        finish_reason: choice?.finish_reason ?? "stop",
      },
      ...(Array.isArray(chat?.choices) ? chat.choices.slice(1) : []),
    ],
  };
  return { chat: patched, patched: true };
}

function sanitizeMessageContent(content: any) {
  if (typeof content === "string") {
    return sanitizeOutputText(content);
  }
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === "string") {
          const next = sanitizeOutputText(part);
          return next ? next : null;
        }
        if (part && typeof part === "object" && typeof part?.text === "string") {
          const next = sanitizeOutputText(part.text);
          if (!next) return null;
          return { ...part, text: next };
        }
        return part;
      })
      .filter((part: any) => part !== null);
  }
  return content;
}

export function sanitizeChatCompletionObject(chat: any) {
  if (!chat || typeof chat !== "object" || chat.object !== "chat.completion")
    return chat;
  const rawChoices = Array.isArray(chat?.choices) ? chat.choices : [];
  const choices = rawChoices.map((choice: any) => {
    const msg = choice?.message ?? {};
    const content = sanitizeMessageContent(msg?.content);
    const rawToolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
    const toolCalls = rawToolCalls.filter((tc: any) =>
      shouldExposeFunctionCallName(tc?.function?.name),
    );
    return {
      ...choice,
      message: {
        ...msg,
        content,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      },
    };
  });
  return { ...chat, choices };
}

function sanitizeResponseMessageItem(item: any): any {
  if (!item || typeof item !== "object") return item;
  if (item.type !== "message") return item;
  const content = Array.isArray(item.content)
    ? item.content
        .filter((part: any) => isVisibleAssistantContentPart(part))
        .map((part: any) => {
          if (part?.type === "output_text" && typeof part?.text === "string") {
            const text = sanitizeOutputText(part.text);
            return text ? { ...part, text } : null;
          }
          if (part?.type === "refusal" && typeof part?.refusal === "string") {
            const refusal = sanitizeOutputText(part.refusal);
            return refusal ? { ...part, refusal } : null;
          }
          return part;
        })
        .filter((part: any) => part !== null)
    : [];
  return { ...item, content };
}

export function stripReasoningFromResponseObject(resp: any) {
  if (!resp || typeof resp !== "object") return resp;
  const output = Array.isArray(resp.output)
    ? resp.output
        .filter((item: any) => item?.type !== "reasoning")
        .filter(
          (item: any) =>
            item?.type !== "function_call" ||
            shouldExposeFunctionCallName(item?.name),
        )
        .map((item: any) => sanitizeResponseMessageItem(item))
    : resp.output;
  const next = { ...resp, output };
  if ("reasoning" in next) delete next.reasoning;
  return next;
}

export function sanitizeResponsesEvent(event: any): SanitizedEventResult {
  if (!event || typeof event !== "object")
    return { drop: false, event, changed: false };
  const type = typeof event.type === "string" ? event.type : "";

  if (
    type.startsWith("response.reasoning") ||
    ((type === "response.output_item.added" ||
      type === "response.output_item.done") &&
      event?.item?.type === "reasoning") ||
    ((type === "response.content_part.added" ||
      type === "response.content_part.done") &&
      !isVisibleAssistantContentPart(event?.part))
  ) {
    return { drop: true, event: null, changed: true };
  }

  if (
    type === "response.completed" &&
    event?.response &&
    typeof event.response === "object"
  ) {
    return {
      drop: false,
      event: {
        ...event,
        response: stripReasoningFromResponseObject(event.response),
      },
      changed: true,
    };
  }

  if (type === "response.output_item.done" && event?.item?.type === "message") {
    return {
      drop: false,
      event: { ...event, item: sanitizeResponseMessageItem(event.item) },
      changed: true,
    };
  }

  if (
    type === "response.output_text.delta" &&
    typeof event?.delta === "string"
  ) {
    const sanitized = sanitizeOutputText(event.delta);
    if (!sanitized) return { drop: true, event: null, changed: true };
    if (sanitized !== event.delta)
      return {
        drop: false,
        event: { ...event, delta: sanitized },
        changed: true,
      };
    return { drop: false, event, changed: false };
  }

  if (type === "response.output_text.done" && typeof event?.text === "string") {
    const sanitized = sanitizeOutputText(event.text);
    if (!sanitized) return { drop: true, event: null, changed: true };
    if (sanitized !== event.text)
      return {
        drop: false,
        event: { ...event, text: sanitized },
        changed: true,
      };
    return { drop: false, event, changed: false };
  }

  if (type === "response.refusal.delta") {
    return { drop: true, event: null, changed: true };
  }

  return { drop: false, event, changed: false };
}

export function sanitizeResponsesSSEFrame(frame: string): string | null {
  const lines = frame.split(/\r?\n/).map((line) => line.trim());
  const eventLine = lines.find((line) => line.startsWith("event:"));
  const dataLines = lines.filter((line) => line.startsWith("data:"));
  if (!dataLines.length) return frame;

  const payload = dataLines
    .map((line) => line.slice(5).trim())
    .join("\n")
    .trim();
  if (!payload || payload === "[DONE]") return frame;

  try {
    const parsed = JSON.parse(payload);
    const sanitized = sanitizeResponsesEvent(parsed);
    if (sanitized.drop) return null;
    if (!sanitized.changed) return frame;
    const sanitizedData = `data: ${JSON.stringify(sanitized.event)}`;
    return eventLine ? `${eventLine}\n${sanitizedData}` : sanitizedData;
  } catch {
    return frame;
  }
}
