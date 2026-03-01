import {
  ensureNonEmptyChatCompletion,
  sanitizeAssistantTextChunk,
  sanitizeChatCompletionObject,
  sanitizeResponsesEvent,
  stripReasoningFromResponseObject,
  withFallbackAssistantContent,
} from "./sanitizers.js";
import { sanitizeOutputText, shouldExposeFunctionCallName } from "./helpers.js";

import { randomUUID } from "node:crypto";

function chatCompletionStreamFrame(
  id: string,
  model: string,
  created: number,
  content: string,
  toolCalls: any[],
  finishReason: string,
  usage: any,
) {
  const deltaPayload: any = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
  const finalPayload: any = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: toolCalls.length ? { tool_calls: toolCalls } : {},
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: usage?.prompt_tokens ?? 0,
      completion_tokens: usage?.completion_tokens ?? 0,
      total_tokens: usage?.total_tokens ?? 0,
    },
  };
  return [
    content ? `data: ${JSON.stringify(deltaPayload)}\n\n` : "",
    `data: ${JSON.stringify(finalPayload)}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}
export function chatCompletionObjectToSSE(chatObj: any): string {
  const sanitized = sanitizeChatCompletionObject(chatObj);
  const normalized = ensureNonEmptyChatCompletion(sanitized).chat;
  const id =
    normalized?.id || `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const model = normalized?.model || "unknown";
  const created = normalized?.created || Math.floor(Date.now() / 1000);
  const choice = normalized?.choices?.[0] || {};
  const content = choice?.message?.content ?? "";
  const toolCalls = Array.isArray(choice?.message?.tool_calls)
    ? choice.message.tool_calls
    : [];
  const finishReason =
    choice?.finish_reason ?? (toolCalls.length ? "tool_calls" : "stop");
  const usage = normalized?.usage || {};

  return chatCompletionStreamFrame(
    id,
    model,
    created,
    content,
    toolCalls,
    finishReason,
    usage,
  );
}

export function responseObjectToSSE(respObj: any): string {
  if (!respObj || typeof respObj !== "object") return "";
  const sanitized = stripReasoningFromResponseObject(respObj);
  return `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: sanitized })}\n\n`;
}

export function responseObjectToChatCompletion(resp: any, model: string) {
  const sanitizedResp = stripReasoningFromResponseObject(resp);
  let outputText = "";
  const toolCalls = Array.isArray(sanitizedResp?.output)
    ? sanitizedResp.output.flatMap((it: any) => {
        if (it?.type === "message") {
          const parts = Array.isArray(it?.content) ? it.content : [];
          for (const p of parts) {
            if (p?.type === "output_text" && typeof p?.text === "string")
              outputText += sanitizeOutputText(p.text);
            if (p?.type === "refusal" && typeof p?.refusal === "string")
              outputText += sanitizeOutputText(p.refusal);
          }
          return [];
        }
        if (it?.type === "function_call") {
          if (!shouldExposeFunctionCallName(it?.name)) return [];
          return [
            {
              id:
                it?.call_id ||
                it?.id ||
                `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
              type: "function",
              function: {
                name: it?.name ?? "unknown",
                arguments:
                  typeof it?.arguments === "string"
                    ? it.arguments
                    : JSON.stringify(it?.arguments ?? {}),
              },
            },
          ];
        }
        return [];
      })
    : [];

  const usage = sanitizedResp?.usage;
  const prompt = usage?.input_tokens ?? 0;
  const completion = usage?.output_tokens ?? 0;
  const total = usage?.total_tokens ?? prompt + completion;
  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";

  const message: any = { role: "assistant", content: outputText || "" };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tc: any, idx: number) => ({
      ...tc,
      index: idx,
    }));
  }

  return {
    id: `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total,
    },
  };
}

export function parseResponsesSSEToResponseObject(sseText: string) {
  let response: any = null;
  let outputText = "";
  for (const rawLine of sseText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload);
      const sanitized = sanitizeResponsesEvent(obj);
      if (sanitized.drop) continue;
      const event = sanitized.event;
      if (event?.type === "response.output_text.delta") {
        outputText += sanitizeAssistantTextChunk(event?.delta ?? "");
      }
      if (event?.type === "response.completed")
        response = stripReasoningFromResponseObject(event?.response);
    } catch {}
  }
  if (!response) {
    return {
      id: `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: outputText }],
        },
      ],
    };
  }
  return response;
}

export function parseResponsesSSEToChatCompletion(
  sseText: string,
  model: string,
) {
  let outputText = "";
  let usage: any = undefined;
  let completedResponse: any = undefined;

  for (const rawLine of sseText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload);
      if (
        obj?.type === "response.output_text.delta" &&
        typeof obj?.delta === "string"
      ) {
        outputText += sanitizeAssistantTextChunk(obj.delta);
      }
      if (
        obj?.type === "response.output_text.done" &&
        !outputText &&
        typeof obj?.text === "string"
      ) {
        outputText = sanitizeAssistantTextChunk(obj.text);
      }
      const sanitized = sanitizeResponsesEvent(obj);
      if (sanitized.drop) continue;
      const event = sanitized.event;
      if (event?.type === "response.completed") {
        usage = event?.response?.usage;
        completedResponse = event?.response;
      }
    } catch {}
  }

  if (completedResponse) {
    const converted = responseObjectToChatCompletion(completedResponse, model);
    return withFallbackAssistantContent(converted, outputText);
  }

  const prompt = usage?.input_tokens ?? 0;
  const completion = usage?.output_tokens ?? 0;
  const total = usage?.total_tokens ?? prompt + completion;

  return {
    id: `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: outputText || "" },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total,
    },
  };
}

export function convertResponsesSSEToChatCompletionSSE(
  upstreamLine: string,
  model: string,
  fallbackText = "",
): string | null {
  if (!upstreamLine.startsWith("data:")) return null;
  const payload = upstreamLine.slice(5).trim();
  if (!payload || payload === "[DONE]")
    return payload === "[DONE]" ? "data: [DONE]\n" : null;

  try {
    const obj = JSON.parse(payload);
    const sanitized = sanitizeResponsesEvent(obj);
    if (sanitized.drop) return null;
    const event = sanitized.event;

    if (
      event?.type === "response.output_text.delta" ||
      event?.type === "response.output_text.done" ||
      event?.type === "response.refusal.delta"
    ) {
      return null;
    }

    if (event?.type === "response.completed") {
      const converted = responseObjectToChatCompletion(event?.response, model);
      return chatCompletionObjectToSSE(
        withFallbackAssistantContent(converted, fallbackText),
      );
    }

    return null;
  } catch {
    return null;
  }
}
