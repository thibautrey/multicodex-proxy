import { randomUUID } from "node:crypto";
import type express from "express";

const EMPTY_ASSISTANT_FALLBACK_TEXT = "[upstream returned no assistant output; please retry]";

function asNonEmptyString(v: any): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

export function extractUsageFromPayload(payload: any) {
  return payload?.usage ?? payload?.response?.usage ?? payload?.metrics?.usage;
}

export function inspectAssistantPayload(payload: any): { assistantEmptyOutput?: boolean; assistantFinishReason?: string } {
  if (!payload || typeof payload !== "object") return {};

  if (payload.object === "chat.completion") {
    const choice = payload?.choices?.[0];
    if (!choice) return {};

    const finishReason = asNonEmptyString(choice.finish_reason);
    const content = choice?.message?.content;
    const contentText = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("")
        : "";
    const hasText = Boolean(asNonEmptyString(contentText));
    const hasToolCalls = Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0;
    const assistantEmptyOutput = !hasText && !hasToolCalls;

    return { assistantEmptyOutput, assistantFinishReason: finishReason };
  }

  if (payload.object === "response") {
    const outputs = Array.isArray(payload?.output) ? payload.output : [];
    const assistantMsg = outputs.find((item: any) => item?.type === "message" && item?.role === "assistant");
    if (!assistantMsg) return {};

    const contentParts = Array.isArray(assistantMsg?.content) ? assistantMsg.content : [];
    const hasOutputText = contentParts.some((part: any) => Boolean(asNonEmptyString(part?.text)));
    const assistantEmptyOutput = !hasOutputText;
    const assistantFinishReason = asNonEmptyString(payload?.status) ?? asNonEmptyString(payload?.stop_reason);
    return { assistantEmptyOutput, assistantFinishReason };
  }

  return {};
}

export function ensureNonEmptyChatCompletion(chat: any): { chat: any; patched: boolean } {
  if (!chat || typeof chat !== "object" || chat.object !== "chat.completion") return { chat, patched: false };
  const choice = chat?.choices?.[0];
  if (!choice) return { chat, patched: false };

  const content = choice?.message?.content;
  const contentText = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("")
      : "";
  const hasText = Boolean(asNonEmptyString(contentText));
  const hasToolCalls = Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0;
  if (hasText || hasToolCalls) return { chat, patched: false };

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

function toUpstreamInputContent(content: any, role: "user" | "assistant") {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") return [{ type: textType, text: content }];
  if (Array.isArray(content)) {
    const out: any[] = [];
    for (const part of content) {
      if (typeof part === "string") out.push({ type: textType, text: part });
      else if ((part?.type === "text" || part?.type === "input_text" || part?.type === "output_text") && typeof part?.text === "string") {
        out.push({ type: textType, text: part.text });
      }
    }
    return out.length ? out : [{ type: textType, text: JSON.stringify(content) }];
  }
  return [{ type: textType, text: String(content ?? "") }];
}

function toolContentToOutput(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" && typeof part?.text === "string") return part.text;
        return "";
      })
      .filter(Boolean);
    if (texts.length) return texts.join("\n");
  }
  try {
    return JSON.stringify(content ?? "");
  } catch {
    return String(content ?? "");
  }
}

export function getSessionId(req: express.Request): string | undefined {
  const raw = req.header("session_id")
    ?? req.header("session-id")
    ?? req.header("x-session-id")
    ?? req.header("x-session_id");
  if (!raw) return undefined;
  const value = String(raw).trim();
  return value || undefined;
}

function clampReasoningEffort(modelId: string, effort: string): string {
  const id = modelId.includes("/") ? modelId.split("/").pop() || modelId : modelId;
  if ((id.startsWith("gpt-5.2") || id.startsWith("gpt-5.3")) && effort === "minimal") return "low";
  if (id === "gpt-5.1" && effort === "xhigh") return "high";
  if (id === "gpt-5.1-codex-mini") return (effort === "high" || effort === "xhigh") ? "high" : "medium";
  return effort;
}

function applyCodexParityDefaults(payload: any, sessionId?: string) {
  const modelId = typeof payload?.model === "string" ? payload.model : "";
  payload.store = false;
  payload.stream = true;
  payload.tool_choice = payload.tool_choice ?? "auto";
  payload.parallel_tool_calls = payload.parallel_tool_calls ?? true;
  payload.text = typeof payload.text === "object" && payload.text !== null ? payload.text : {};
  payload.text.verbosity = payload.text.verbosity ?? "medium";
  if (!Array.isArray(payload.include)) payload.include = ["reasoning.encrypted_content"];
  else if (!payload.include.includes("reasoning.encrypted_content")) payload.include.push("reasoning.encrypted_content");
  if (sessionId && typeof payload.prompt_cache_key === "undefined") payload.prompt_cache_key = sessionId;

  if (typeof payload.reasoning_effort !== "undefined") {
    payload.reasoning = typeof payload.reasoning === "object" && payload.reasoning !== null ? payload.reasoning : {};
    payload.reasoning.effort = payload.reasoning_effort;
    delete payload.reasoning_effort;
  }
  if (payload.reasoning && typeof payload.reasoning === "object" && typeof payload.reasoning.effort === "string") {
    payload.reasoning.effort = clampReasoningEffort(modelId, payload.reasoning.effort);
    if (typeof payload.reasoning.summary === "undefined") payload.reasoning.summary = "auto";
  }
}

export function normalizeResponsesPayload(body: any, sessionId?: string) {
  const b = { ...(body ?? {}) };
  if (!Array.isArray(b.input)) {
    const text = typeof b.input === "string" ? b.input : (typeof b.prompt === "string" ? b.prompt : "");
    b.input = [{ role: "user", content: [{ type: "input_text", text }] }];
  }

  const model = String(b.model ?? "");
  if (model.startsWith("gpt-5") && typeof b.max_output_tokens !== "undefined") {
    delete b.max_output_tokens;
  }
  applyCodexParityDefaults(b, sessionId);
  return b;
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
      if (obj?.type === "response.output_text.delta") outputText += obj?.delta ?? "";
      if (obj?.type === "response.completed") response = obj?.response;
    } catch {}
  }
  if (!response) {
    return {
      id: `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: outputText }] }],
    };
  }
  return response;
}

export function chatCompletionsToResponsesPayload(body: any, sessionId?: string) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const systemInstructions = messages
    .filter((m: any) => m?.role === "system")
    .map((m: any) => (typeof m?.content === "string" ? m.content : ""))
    .filter(Boolean)
    .join("\n\n");

  let input: any[] = [];
  for (const m of messages) {
    if (m?.role === "system") continue;

    if (m?.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m?.tool_call_id ?? `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        output: toolContentToOutput(m?.content),
      });
      continue;
    }

    if (m?.role === "assistant") {
      const assistantContent = toUpstreamInputContent(m?.content, "assistant");
      if (assistantContent.length > 0) {
        input.push({ role: "assistant", content: assistantContent });
      }

      const toolCalls = Array.isArray(m?.tool_calls) ? m.tool_calls : [];
      for (const tc of toolCalls) {
        input.push({
          type: "function_call",
          call_id: tc?.id ?? `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
          name: tc?.function?.name ?? "unknown",
          arguments: typeof tc?.function?.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc?.function?.arguments ?? {}),
        });
      }
      continue;
    }

    input.push({
      role: "user",
      content: toUpstreamInputContent(m?.content, "user"),
    });
  }

  if (input.length > 0 && input[0]?.role !== "user") {
    input = [
      { role: "user", content: [{ type: "input_text", text: " " }] },
      ...input,
    ];
  }

  const payload: any = {
    model: body?.model,
    instructions: body?.instructions || systemInstructions || undefined,
    input,
  };

  if (body?.tools && Array.isArray(body.tools)) {
    payload.tools = body.tools.map((tool: any) => {
      if (tool.type === "function" && tool.function) {
        return {
          type: "function",
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
          strict: tool.function.strict ?? null,
        };
      }
      return tool;
    });
  }
  if (body?.tool_choice) {
    payload.tool_choice = body.tool_choice;
  }
  if (body?.reasoning_effort !== undefined) {
    payload.reasoning_effort = body.reasoning_effort;
  }
  if (body?.reasoning !== undefined) {
    payload.reasoning = body.reasoning;
  }
  if (body?.temperature !== undefined) {
    payload.temperature = body.temperature;
  }

  applyCodexParityDefaults(payload, sessionId);
  return payload;
}

export function responseObjectToChatCompletion(resp: any, model: string) {
  let outputText = "";
  const toolCalls = Array.isArray(resp?.output)
    ? resp.output
      .flatMap((it: any) => {
        if (it?.type === "message") {
          const parts = Array.isArray(it?.content) ? it.content : [];
          for (const p of parts) {
            if ((p?.type === "output_text" || p?.type === "text") && typeof p?.text === "string") outputText += p.text;
          }
          return [];
        }
        if (it?.type === "function_call") {
          return [{
            id: it?.call_id || it?.id || `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
            type: "function",
            function: {
              name: it?.name ?? "unknown",
              arguments: typeof it?.arguments === "string" ? it.arguments : JSON.stringify(it?.arguments ?? {}),
            },
          }];
        }
        return [];
      })
    : [];

  const usage = resp?.usage;
  const prompt = usage?.input_tokens ?? 0;
  const completion = usage?.output_tokens ?? 0;
  const total = usage?.total_tokens ?? prompt + completion;
  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";

  const message: any = { role: "assistant", content: outputText || "" };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tc: any, idx: number) => ({ ...tc, index: idx }));
  }

  return {
    id: `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total },
  };
}

export function parseResponsesSSEToChatCompletion(sseText: string, model: string) {
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
      if (obj?.type === "response.output_text.delta") outputText += obj?.delta ?? "";
      if (obj?.type === "response.output_text.done" && !outputText) outputText = obj?.text ?? "";
      if (obj?.type === "response.completed") {
        usage = obj?.response?.usage;
        completedResponse = obj?.response;
      }
    } catch {}
  }

  if (completedResponse) {
    const converted = responseObjectToChatCompletion(completedResponse, model);
    if (!converted?.choices?.[0]?.message?.content && outputText) {
      converted.choices[0].message.content = outputText;
    }
    return converted;
  }

  const prompt = usage?.input_tokens ?? 0;
  const completion = usage?.output_tokens ?? 0;
  const total = usage?.total_tokens ?? prompt + completion;

  return {
    id: `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: outputText || "" }, finish_reason: "stop" }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total },
  };
}

export function convertResponsesSSEToChatCompletionSSE(upstreamLine: string, model: string): string | null {
  if (!upstreamLine.startsWith("data:")) return null;
  const payload = upstreamLine.slice(5).trim();
  if (!payload || payload === "[DONE]") return payload === "[DONE]" ? "data: [DONE]\n" : null;

  try {
    const obj = JSON.parse(payload);

    if (obj?.type === "response.output_text.delta") {
      const delta = obj?.delta ?? "";
      const chatDelta = {
        id: `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: delta ? { content: delta } : {}, finish_reason: null }],
      };
      return `data: ${JSON.stringify(chatDelta)}\n\n`;
    }

    if (obj?.type === "response.output_text.done") {
      const text = obj?.text ?? "";
      if (!text) return null;
      const chatDelta = {
        id: `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      };
      return `data: ${JSON.stringify(chatDelta)}\n\n`;
    }

    if (obj?.type === "response.completed") {
      const usage = obj?.response?.usage;
      const toolCalls = Array.isArray(obj?.response?.output)
        ? obj.response.output
          .filter((it: any) => it?.type === "function_call")
          .map((it: any, idx: number) => ({
            index: idx,
            id: it?.call_id || it?.id || `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
            type: "function",
            function: {
              name: it?.name ?? "unknown",
              arguments: typeof it?.arguments === "string" ? it.arguments : JSON.stringify(it?.arguments ?? {}),
            },
          }))
        : [];

      const finalChunk = {
        id: `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          delta: toolCalls.length ? { tool_calls: toolCalls } : {},
          finish_reason: toolCalls.length ? "tool_calls" : "stop",
        }],
        usage: {
          prompt_tokens: usage?.input_tokens ?? 0,
          completion_tokens: usage?.output_tokens ?? 0,
          total_tokens: usage?.total_tokens ?? 0,
        },
      };
      return `data: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`;
    }

    return null;
  } catch {
    return null;
  }
}

export function chatCompletionObjectToSSE(chatObj: any): string {
  const normalized = ensureNonEmptyChatCompletion(chatObj).chat;
  const id = normalized?.id || `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const model = normalized?.model || "unknown";
  const created = normalized?.created || Math.floor(Date.now() / 1000);
  const choice = normalized?.choices?.[0] || {};
  const content = choice?.message?.content ?? "";
  const toolCalls = Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [];
  const finishReason = choice?.finish_reason ?? (toolCalls.length ? "tool_calls" : "stop");
  const usage = normalized?.usage || {};

  const chunks: string[] = [];
  if (content) {
    chunks.push(`data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`);
  }

  chunks.push(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{
      index: 0,
      delta: toolCalls.length ? { tool_calls: toolCalls } : {},
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: usage?.prompt_tokens ?? 0,
      completion_tokens: usage?.completion_tokens ?? 0,
      total_tokens: usage?.total_tokens ?? 0,
    },
  })}\n\n`);

  chunks.push("data: [DONE]\n\n");
  return chunks.join("");
}
