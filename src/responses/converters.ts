import {
  ensureNonEmptyChatCompletion,
  isValidChatToolCall,
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
  functionCallsDone: boolean;
  completedSent: boolean;
};

type ResponsesToChatToolState = {
  index: number;
  outputIndex?: number;
  itemId?: string;
  callId: string;
  name: string;
  arguments: string;
  emittedArgumentLength: number;
  introduced: boolean;
};

export type ResponsesToChatCompletionStreamState = {
  id: string;
  model: string;
  created: number;
  content: string;
  tools: ResponsesToChatToolState[];
  usage: any;
  roleSent: boolean;
  assistantOutputSent: boolean;
  completedReceived: boolean;
  finalized: boolean;
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
    .filter((tc: any) => isValidChatToolCall(tc))
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

function responseFunctionCallFrames(state: ChatStreamAccumulator) {
  if (state.functionCallsDone) return "";
  const toolCalls = normalizeChatToolCalls(state.toolCalls);
  if (!toolCalls.length) return "";

  state.functionCallsDone = true;
  const out: string[] = [responseCreatedFrame(state)];
  const firstOutputIndex = state.contentStarted ? 1 : 0;

  toolCalls.forEach((tc: any, idx: number) => {
    const outputIndex = firstOutputIndex + idx;
    const item = {
      id: tc.id,
      type: "function_call",
      status: "in_progress",
      arguments: "",
      call_id: tc.id,
      name: tc.function.name,
    };
    const doneItem = {
      ...item,
      status: "completed",
      arguments: tc.function.arguments,
    };

    out.push(`event: response.output_item.added\ndata: ${JSON.stringify({
      type: "response.output_item.added",
      output_index: outputIndex,
      item,
    })}\n\n`);

    if (tc.function.arguments) {
      out.push(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id: tc.id,
        output_index: outputIndex,
        delta: tc.function.arguments,
      })}\n\n`);
    }

    out.push(`event: response.function_call_arguments.done\ndata: ${JSON.stringify({
      type: "response.function_call_arguments.done",
      item_id: tc.id,
      output_index: outputIndex,
      arguments: tc.function.arguments,
    })}\n\n`);

    out.push(`event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done",
      output_index: outputIndex,
      item: doneItem,
    })}\n\n`);
  });

  return out.join("");
}

export function finalizeChatCompletionSSEToResponseSSE(
  state: ChatStreamAccumulator,
): string | null {
  if (state.completedSent) return null;
  state.completedSent = true;
  return `${responseCreatedFrame(state)}${responseContentDoneFrames(state)}${responseFunctionCallFrames(state)}${responseObjectToSSE(
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
    functionCallsDone: false,
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

export function createResponsesToChatCompletionStreamState(
  model: string,
): ResponsesToChatCompletionStreamState {
  return {
    id: `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    model,
    created: Math.floor(Date.now() / 1000),
    content: "",
    tools: [],
    usage: undefined,
    roleSent: false,
    assistantOutputSent: false,
    completedReceived: false,
    finalized: false,
  };
}

function responsesChatChunk(
  state: ResponsesToChatCompletionStreamState,
  delta: any,
  finishReason: string | null = null,
  usage?: any,
): string {
  const nextDelta = state.roleSent ? delta : { role: "assistant", ...delta };
  state.roleSent = true;
  const chunk: any = {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta: nextDelta, finish_reason: finishReason }],
  };
  if (usage !== undefined) chunk.usage = usageResponsesToChat(usage);
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function responseToolKey(value: any): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function findResponseTool(
  state: ResponsesToChatCompletionStreamState,
  event: any,
): ResponsesToChatToolState | undefined {
  const itemId = responseToolKey(event?.item_id ?? event?.item?.id);
  const callId = responseToolKey(event?.call_id ?? event?.item?.call_id);
  const outputIndex =
    typeof event?.output_index === "number" ? event.output_index : undefined;
  return state.tools.find(
    (tool) =>
      (itemId && tool.itemId === itemId) ||
      (callId && tool.callId === callId) ||
      (outputIndex !== undefined && tool.outputIndex === outputIndex),
  );
}

function getOrCreateResponseTool(
  state: ResponsesToChatCompletionStreamState,
  event: any,
): ResponsesToChatToolState {
  const existing = findResponseTool(state, event);
  if (existing) return existing;
  const item = event?.item ?? event;
  const itemId = responseToolKey(event?.item_id ?? item?.id);
  const callId =
    responseToolKey(event?.call_id ?? item?.call_id ?? item?.id) ??
    `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const tool: ResponsesToChatToolState = {
    index: state.tools.length,
    outputIndex:
      typeof event?.output_index === "number" ? event.output_index : undefined,
    itemId,
    callId,
    name: typeof item?.name === "string" ? item.name : "",
    arguments: "",
    emittedArgumentLength: 0,
    introduced: false,
  };
  state.tools.push(tool);
  return tool;
}

function introduceResponseTool(
  state: ResponsesToChatCompletionStreamState,
  tool: ResponsesToChatToolState,
): string {
  if (
    tool.introduced ||
    !tool.name ||
    !shouldExposeFunctionCallName(tool.name)
  ) {
    return "";
  }
  tool.introduced = true;
  state.assistantOutputSent = true;
  return responsesChatChunk(state, {
    tool_calls: [
      {
        index: tool.index,
        id: tool.callId,
        type: "function",
        function: { name: tool.name, arguments: "" },
      },
    ],
  });
}

function emitResponseToolArguments(
  state: ResponsesToChatCompletionStreamState,
  tool: ResponsesToChatToolState,
): string {
  if (!tool.introduced || tool.emittedArgumentLength >= tool.arguments.length) {
    return "";
  }
  const delta = tool.arguments.slice(tool.emittedArgumentLength);
  tool.emittedArgumentLength = tool.arguments.length;
  state.assistantOutputSent = true;
  return responsesChatChunk(state, {
    tool_calls: [
      {
        index: tool.index,
        function: { arguments: delta },
      },
    ],
  });
}

function appendResponseToolArguments(
  tool: ResponsesToChatToolState,
  value: any,
  complete: boolean,
): void {
  if (typeof value !== "string") return;
  if (!complete) {
    tool.arguments += value;
    return;
  }
  if (!tool.arguments) {
    tool.arguments = value;
  } else if (value.startsWith(tool.arguments)) {
    tool.arguments = value;
  }
}

function emitResponseText(
  state: ResponsesToChatCompletionStreamState,
  value: any,
  complete: boolean,
): string {
  if (typeof value !== "string") return "";
  const sanitized = sanitizeAssistantTextChunk(value);
  if (!sanitized) return "";
  let delta = sanitized;
  if (complete && state.content) {
    if (!sanitized.startsWith(state.content)) return "";
    delta = sanitized.slice(state.content.length);
  }
  if (!delta) return "";
  state.content += delta;
  state.assistantOutputSent = true;
  return responsesChatChunk(state, { content: delta });
}

function hydrateResponsesCompletion(
  state: ResponsesToChatCompletionStreamState,
  response: any,
): string {
  const out: string[] = [];
  if (typeof response?.model === "string" && response.model) {
    state.model = response.model;
  }
  if (typeof response?.created_at === "number") {
    state.created = response.created_at;
  }
  state.usage = response?.usage ?? state.usage;
  const output = Array.isArray(response?.output) ? response.output : [];
  for (const item of output) {
    if (item?.type === "message") {
      const text = (Array.isArray(item?.content) ? item.content : [])
        .map((part: any) =>
          part?.type === "output_text"
            ? part?.text
            : part?.type === "refusal"
              ? part?.refusal
              : "",
        )
        .filter((part: any) => typeof part === "string")
        .join("");
      const converted = emitResponseText(state, text, true);
      if (converted) out.push(converted);
      continue;
    }
    if (item?.type !== "function_call") continue;
    const tool = getOrCreateResponseTool(state, { item });
    if (typeof item?.name === "string") tool.name = item.name;
    appendResponseToolArguments(tool, item?.arguments, true);
    const introduced = introduceResponseTool(state, tool);
    if (introduced) out.push(introduced);
    const args = emitResponseToolArguments(state, tool);
    if (args) out.push(args);
  }
  return out.join("");
}

export function finalizeResponsesSSEToChatCompletionSSE(
  state: ResponsesToChatCompletionStreamState,
): string | null {
  if (state.finalized || !state.assistantOutputSent) return null;
  state.finalized = true;
  const finishReason = state.tools.some((tool) => tool.introduced)
    ? "tool_calls"
    : "stop";
  return `${responsesChatChunk(state, {}, finishReason, state.usage)}data: [DONE]\n\n`;
}

export function convertResponsesSSEToChatCompletionSSE(
  frame: string,
  state: ResponsesToChatCompletionStreamState,
): string | null {
  const out: string[] = [];
  const dataLines = frame
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"));

  for (const line of dataLines) {
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let rawEvent: any;
    try {
      rawEvent = JSON.parse(payload);
    } catch {
      continue;
    }
    const sanitized = sanitizeResponsesEvent(rawEvent);
    if (sanitized.drop) continue;
    const event = sanitized.event;
    const type = event?.type;

    if (type === "response.created") {
      const response = event?.response;
      if (typeof response?.model === "string" && response.model) {
        state.model = response.model;
      }
      if (typeof response?.created_at === "number") {
        state.created = response.created_at;
      }
      continue;
    }
    if (type === "response.output_text.delta") {
      const converted = emitResponseText(state, event?.delta, false);
      if (converted) out.push(converted);
      continue;
    }
    if (type === "response.output_text.done") {
      const converted = emitResponseText(state, event?.text, true);
      if (converted) out.push(converted);
      continue;
    }
    if (
      (type === "response.output_item.added" ||
        type === "response.output_item.done") &&
      event?.item?.type === "function_call"
    ) {
      const tool = getOrCreateResponseTool(state, event);
      if (typeof event.item?.name === "string") tool.name = event.item.name;
      appendResponseToolArguments(
        tool,
        event.item?.arguments,
        type === "response.output_item.done",
      );
      const introduced = introduceResponseTool(state, tool);
      if (introduced) out.push(introduced);
      const args = emitResponseToolArguments(state, tool);
      if (args) out.push(args);
      continue;
    }
    if (type === "response.function_call_arguments.delta") {
      const tool = getOrCreateResponseTool(state, event);
      appendResponseToolArguments(tool, event?.delta, false);
      const args = emitResponseToolArguments(state, tool);
      if (args) out.push(args);
      continue;
    }
    if (type === "response.function_call_arguments.done") {
      const tool = getOrCreateResponseTool(state, event);
      appendResponseToolArguments(tool, event?.arguments, true);
      const args = emitResponseToolArguments(state, tool);
      if (args) out.push(args);
      continue;
    }
    if (type === "response.completed") {
      state.completedReceived = true;
      const converted = hydrateResponsesCompletion(state, event?.response);
      if (converted) out.push(converted);
      const completed = finalizeResponsesSSEToChatCompletionSSE(state);
      if (completed) out.push(completed);
    }
  }

  return out.length ? out.join("") : null;
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
