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

export type ChatStreamAccumulator = {
  id: string;
  responseId: string;
  outputItemId: string;
  model: string;
  created: number;
  content: string;
  pendingText: string;
  insideThinkBlock: boolean;
  toolCalls: any[];
  usage: any;
  finishReason: string;
  createdSent: boolean;
  contentStarted: boolean;
  contentDone: boolean;
  completedSent: boolean;
};

function usageChatToResponses(usage: any) {
  if (!usage || typeof usage !== "object") return undefined;
  const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const output = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const total = usage.total_tokens ?? input + output;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
  };
}

function stripThinkBlocks(text: string) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "");
}

function appendVisibleChatDelta(
  state: ChatStreamAccumulator,
  text: string,
): string {
  if (!text) return "";
  let combined = state.pendingText + text;
  state.pendingText = "";
  let visible = "";

  while (combined) {
    if (state.insideThinkBlock) {
      const end = combined.toLowerCase().indexOf("</think>");
      if (end === -1) return visible;
      combined = combined.slice(end + "</think>".length);
      state.insideThinkBlock = false;
      continue;
    }

    const lower = combined.toLowerCase();
    const start = lower.indexOf("<think>");
    if (start === -1) {
      const tailMatch = combined.match(/<think?$/i);
      if (tailMatch?.index !== undefined) {
        visible += combined.slice(0, tailMatch.index);
        state.pendingText = combined.slice(tailMatch.index);
      } else {
        visible += combined;
      }
      break;
    }

    visible += combined.slice(0, start);
    combined = combined.slice(start + "<think>".length);
    state.insideThinkBlock = true;
  }

  const sanitized = sanitizeAssistantTextChunk(visible);
  if (sanitized) state.content += sanitized;
  return sanitized;
}

function usageResponsesToChat(usage: any) {
  if (!usage || typeof usage !== "object") {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }
  const prompt = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const completion = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const total = usage.total_tokens ?? prompt + completion;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
}

function normalizeChatToolCalls(toolCalls: any[]): any[] {
  return toolCalls
    .filter((tc: any) => shouldExposeFunctionCallName(tc?.function?.name))
    .map((tc: any, idx: number) => ({
      id: tc?.id ?? `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      type: "function",
      function: {
        name: tc?.function?.name ?? "unknown",
        arguments:
          typeof tc?.function?.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc?.function?.arguments ?? {}),
      },
      index: typeof tc?.index === "number" ? tc.index : idx,
    }));
}

function responseOutputFromChatMessage(message: any) {
  const output: any[] = [];
  const rawContent = message?.content;
  const contentText = Array.isArray(rawContent)
    ? rawContent
        .map((part: any) => {
          if (typeof part === "string") return part;
          if (typeof part?.text === "string") return part.text;
          return "";
        })
        .join("")
    : typeof rawContent === "string"
      ? rawContent
      : "";
  const sanitizedText = sanitizeOutputText(stripThinkBlocks(contentText)).trimStart();
  if (sanitizedText) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: sanitizedText }],
    });
  }

  const toolCalls = Array.isArray(message?.tool_calls)
    ? normalizeChatToolCalls(message.tool_calls)
    : [];
  for (const tc of toolCalls) {
    output.push({
      type: "function_call",
      id: tc.id,
      call_id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    });
  }

  if (!output.length) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "" }],
    });
  }

  return output;
}

export function chatCompletionObjectToResponseObject(
  chatObj: any,
  fallbackModel = "unknown",
) {
  const sanitized = sanitizeChatCompletionObject(chatObj);
  const normalized = ensureNonEmptyChatCompletion(sanitized).chat;
  const choice = normalized?.choices?.[0] ?? {};
  const responseId = `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  return {
    id: responseId,
    object: "response",
    created_at: normalized?.created ?? Math.floor(Date.now() / 1000),
    model: normalized?.model ?? fallbackModel,
    status: "completed",
    output: responseOutputFromChatMessage(choice?.message ?? {}),
    usage: usageChatToResponses(normalized?.usage),
  };
}

function mergeToolCallDelta(toolCalls: any[], deltaToolCall: any) {
  const idx =
    typeof deltaToolCall?.index === "number"
      ? deltaToolCall.index
      : toolCalls.length;
  const current = toolCalls[idx] ?? {
    id: deltaToolCall?.id,
    type: "function",
    function: { name: "", arguments: "" },
    index: idx,
  };

  const fn = deltaToolCall?.function ?? {};
  toolCalls[idx] = {
    ...current,
    id: deltaToolCall?.id ?? current.id,
    type: "function",
    index: idx,
    function: {
      name:
        typeof fn.name === "string" && fn.name
          ? `${current.function?.name ?? ""}${fn.name}`
          : current.function?.name ?? "",
      arguments:
        typeof fn.arguments === "string"
          ? `${current.function?.arguments ?? ""}${fn.arguments}`
          : current.function?.arguments ?? "",
    },
  };
}

function responseObjectFromChatStreamState(state: ChatStreamAccumulator) {
  const message: any = { role: "assistant", content: state.content };
  const toolCalls = normalizeChatToolCalls(state.toolCalls);
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: state.responseId,
    object: "response",
    created_at: state.created,
    model: state.model,
    status: "completed",
    output: responseOutputFromChatMessage(message),
    usage: usageChatToResponses(state.usage),
  };
}

function chatCompletionObjectFromChatStreamState(state: ChatStreamAccumulator) {
  const toolCalls = normalizeChatToolCalls(state.toolCalls);
  const message: any = { role: "assistant", content: state.content };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: state.id,
    object: "chat.completion",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: state.finishReason,
      },
    ],
    usage: usageResponsesToChat(usageChatToResponses(state.usage)),
  };
}

function applyChatCompletionChunk(
  chunk: any,
  state: ChatStreamAccumulator,
): string {
  if (typeof chunk.id === "string" && chunk.id) state.id = chunk.id;
  if (typeof chunk.model === "string" && chunk.model) state.model = chunk.model;
  if (typeof chunk.created === "number") state.created = chunk.created;
  if (chunk.usage) state.usage = chunk.usage;

  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
  if (!choice) return "";
  if (typeof choice.finish_reason === "string") {
    state.finishReason = choice.finish_reason;
  }
  const delta = choice.delta ?? {};
  let sanitized = "";
  if (typeof delta.content === "string") {
    sanitized = appendVisibleChatDelta(state, delta.content);
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) mergeToolCallDelta(state.toolCalls, tc);
  }
  return sanitized;
}

function responseCreatedFrame(state: ChatStreamAccumulator) {
  if (state.createdSent) return "";
  state.createdSent = true;
  return `event: response.created\ndata: ${JSON.stringify({
    type: "response.created",
    response: {
      id: state.responseId,
      object: "response",
      created_at: state.created,
      model: state.model,
      status: "in_progress",
    },
  })}\n\n`;
}

function responseContentStartFrames(state: ChatStreamAccumulator) {
  if (state.contentStarted) return "";
  state.contentStarted = true;
  return `${responseCreatedFrame(state)}event: response.output_item.added\ndata: ${JSON.stringify({
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: state.outputItemId,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    },
  })}\n\nevent: response.content_part.added\ndata: ${JSON.stringify({
    type: "response.content_part.added",
    item_id: state.outputItemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" },
  })}\n\n`;
}

function responseContentDoneFrames(state: ChatStreamAccumulator) {
  if (state.contentDone || !state.contentStarted) return "";
  state.contentDone = true;
  return `event: response.output_text.done\ndata: ${JSON.stringify({
    type: "response.output_text.done",
    item_id: state.outputItemId,
    output_index: 0,
    content_index: 0,
    text: state.content,
  })}\n\nevent: response.content_part.done\ndata: ${JSON.stringify({
    type: "response.content_part.done",
    item_id: state.outputItemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: state.content },
  })}\n\nevent: response.output_item.done\ndata: ${JSON.stringify({
    type: "response.output_item.done",
    output_index: 0,
    item: {
      id: state.outputItemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: state.content }],
    },
  })}\n\n`;
}

export function finalizeChatCompletionSSEToResponseSSE(
  state: ChatStreamAccumulator,
): string | null {
  if (state.completedSent) return null;
  state.completedSent = true;
  return `${responseCreatedFrame(state)}${responseContentDoneFrames(state)}${responseObjectToSSE(
    responseObjectFromChatStreamState(state),
  )}`;
}

export function createChatStreamAccumulator(
  model: string,
): ChatStreamAccumulator {
  return {
    id: `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    responseId: `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    outputItemId: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    model,
    created: Math.floor(Date.now() / 1000),
    content: "",
    pendingText: "",
    insideThinkBlock: false,
    toolCalls: [],
    usage: undefined,
    finishReason: "stop",
    createdSent: false,
    contentStarted: false,
    contentDone: false,
    completedSent: false,
  };
}

export function convertChatCompletionSSEToResponseSSE(
  frame: string,
  state: ChatStreamAccumulator,
): string | null {
  const lines = frame.split(/\r?\n/).map((line) => line.trim());
  const dataLines = lines.filter((line) => line.startsWith("data:"));
  if (!dataLines.length) return null;

  const out: string[] = [];
  for (const line of dataLines) {
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === "[DONE]") {
      const completed = finalizeChatCompletionSSEToResponseSSE(state);
      if (completed) out.push(completed);
      continue;
    }

    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (chunk?.object !== "chat.completion.chunk") continue;

    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) continue;
    const sanitized = applyChatCompletionChunk(chunk, state);
    if (sanitized) {
      out.push(
        `${responseContentStartFrames(state)}event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: state.outputItemId, output_index: 0, content_index: 0, delta: sanitized })}\n\n`,
      );
    }
  }

  return out.length ? out.join("") : null;
}

export function parseChatCompletionSSEToChatCompletion(
  sseText: string,
  model: string,
) {
  const state = createChatStreamAccumulator(model);
  for (const rawLine of sseText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload);
      if (chunk?.object === "chat.completion.chunk") {
        applyChatCompletionChunk(chunk, state);
      }
    } catch {}
  }
  return chatCompletionObjectFromChatStreamState(state);
}

export function parseChatCompletionSSEToResponseObject(
  sseText: string,
  model: string,
) {
  return chatCompletionObjectToResponseObject(
    parseChatCompletionSSEToChatCompletion(sseText, model),
    model,
  );
}

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
