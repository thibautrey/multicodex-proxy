import {
  applyCodexParityDefaults,
  asNonEmptyString,
  toUpstreamInputContent,
  toolContentToOutput,
} from "./helpers.js";
import {
  isValidChatToolCall,
  isValidResponseFunctionCall,
} from "./sanitizers.js";

import express from "express";
import { randomUUID } from "node:crypto";

export function extractUsageFromPayload(payload: any) {
  return payload?.usage ?? payload?.response?.usage ?? payload?.metrics?.usage;
}

export function getSessionId(req: express.Request): string | undefined {
  const raw =
    req.header("session_id") ??
    req.header("session-id") ??
    req.header("x-session-id") ??
    req.header("x-session_id");
  if (!raw) return undefined;
  const value = String(raw).trim();
  return value || undefined;
}

function responseImagePartToChatPart(part: any): any | null {
  if (part?.type !== "input_image") return null;
  let url =
    typeof part.image_url === "string"
      ? part.image_url
      : part.image_url?.url;
  if ((!url || typeof url !== "string") && typeof part.data === "string") {
    const mimeType =
      typeof part.mime_type === "string" && part.mime_type.trim()
        ? part.mime_type.trim()
        : "image/png";
    url = `data:${mimeType};base64,${part.data}`;
  }
  if (typeof url !== "string" || !url.trim()) return null;

  const imageUrl: any = { url };
  const detail =
    typeof part.detail === "string"
      ? part.detail
      : typeof part.image_url?.detail === "string"
        ? part.image_url.detail
        : undefined;
  if (detail) imageUrl.detail = detail;
  return { type: "image_url", image_url: imageUrl };
}

export function inspectAssistantPayload(payload: any): {
  assistantEmptyOutput?: boolean;
  assistantFinishReason?: string;
} {
  if (!payload || typeof payload !== "object") return {};

  if (payload.object === "chat.completion") {
    const choice = payload?.choices?.[0];
    if (!choice) return {};

    const finishReason = asNonEmptyString(choice.finish_reason);
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
      choice.message.tool_calls.some((tc: any) => isValidChatToolCall(tc));
    const assistantEmptyOutput = !hasText && !hasToolCalls;

    return { assistantEmptyOutput, assistantFinishReason: finishReason };
  }

  if (payload.object === "response") {
    const outputs = Array.isArray(payload?.output) ? payload.output : [];
    const hasFunctionCall = outputs.some((item: any) =>
      isValidResponseFunctionCall(item),
    );
    const assistantMsg = outputs.find(
      (item: any) => item?.type === "message" && item?.role === "assistant",
    );
    if (!assistantMsg) {
      return {
        assistantEmptyOutput: !hasFunctionCall,
        assistantFinishReason:
          asNonEmptyString(payload?.status) ??
          asNonEmptyString(payload?.stop_reason),
      };
    }

    const contentParts = Array.isArray(assistantMsg?.content)
      ? assistantMsg.content
      : [];
    const hasOutputText = contentParts.some((part: any) =>
      Boolean(asNonEmptyString(part?.text)),
    );
    const assistantEmptyOutput = !hasOutputText && !hasFunctionCall;
    const assistantFinishReason =
      asNonEmptyString(payload?.status) ??
      asNonEmptyString(payload?.stop_reason);
    return { assistantEmptyOutput, assistantFinishReason };
  }

  return {};
}

export function normalizeResponsesPayload(body: any, sessionId?: string) {
  const b = { ...(body ?? {}) };
  if (!Array.isArray(b.input)) {
    const text =
      typeof b.input === "string"
        ? b.input
        : typeof b.prompt === "string"
          ? b.prompt
          : "";
    b.input = [{ role: "user", content: [{ type: "input_text", text }] }];
  }

  const model = String(b.model ?? "");
  if (model.startsWith("gpt-5") && typeof b.max_output_tokens !== "undefined") {
    delete b.max_output_tokens;
  }
  applyCodexParityDefaults(b, sessionId);
  return b;
}

export function chatCompletionsToResponsesPayload(
  body: any,
  sessionId?: string,
) {
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
        call_id:
          m?.tool_call_id ??
          `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
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
          call_id:
            tc?.id ?? `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
          name: tc?.function?.name ?? "unknown",
          arguments:
            typeof tc?.function?.arguments === "string"
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

export function responsesToChatCompletionsPayload(body: any) {
  const payload = { ...(body ?? {}) };
  const input = Array.isArray(payload.input) ? payload.input : [];
  const messages: any[] = [];

  const instructions =
    typeof payload.instructions === "string" ? payload.instructions.trim() : "";
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  if (typeof payload.input === "string") {
    messages.push({ role: "user", content: payload.input });
  } else if (!Array.isArray(payload.input) && typeof payload.prompt === "string") {
    messages.push({ role: "user", content: payload.prompt });
  }

  for (const item of input) {
    if (item?.type === "input_image") {
      const imagePart = responseImagePartToChatPart(item);
      if (imagePart) messages.push({ role: "user", content: [imagePart] });
      continue;
    }

    if (item?.type === "function_call") {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: item.call_id ?? item.id ?? `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
            type: "function",
            function: {
              name: item.name ?? "unknown",
              arguments:
                typeof item.arguments === "string"
                  ? item.arguments
                  : JSON.stringify(item.arguments ?? {}),
            },
          },
        ],
      });
      continue;
    }

    if (item?.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id:
          item.call_id ?? item.id ?? `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        content:
          typeof item.output === "string"
            ? item.output
            : JSON.stringify(item.output ?? ""),
      });
      continue;
    }

    const role =
      item?.role === "assistant"
        ? "assistant"
        : item?.role === "system"
          ? "system"
          : "user";
    const content = Array.isArray(item?.content)
      ? item.content
          .map((part: any) => {
            if (typeof part === "string") return { type: "text", text: part };
            if (typeof part?.text === "string") return { type: "text", text: part.text };
            if (part?.type === "input_image") return responseImagePartToChatPart(part);
            return null;
          })
          .filter(Boolean)
      : typeof item?.content === "string"
        ? item.content
        : "";

    messages.push({ role, content });
  }

  const out: any = {
    model: payload.model,
    messages,
    stream: payload.stream ?? true,
  };

  if (Array.isArray(payload.tools)) {
    out.tools = payload.tools.map((tool: any) => {
      if (tool?.type === "function") {
        return {
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: tool.strict,
          },
        };
      }
      return tool;
    });
  }
  if (typeof payload.tool_choice !== "undefined") out.tool_choice = payload.tool_choice;
  if (typeof payload.temperature !== "undefined") out.temperature = payload.temperature;
  const outputLimit =
    payload.max_tokens ?? payload.max_completion_tokens ?? payload.max_output_tokens;
  if (typeof outputLimit !== "undefined") out.max_tokens = outputLimit;
  return out;
}

export function sanitizeGenericChatCompletionsPayload(body: any) {
  const out = { ...(body ?? {}) };
  delete out.reasoning;
  delete out.reasoning_effort;
  delete out.include;
  delete out.text;
  delete out.store;
  delete out.parallel_tool_calls;
  if (typeof out.max_output_tokens !== "undefined") {
    out.max_tokens = out.max_tokens ?? out.max_output_tokens;
    delete out.max_output_tokens;
  }
  if (typeof out.max_completion_tokens !== "undefined") {
    out.max_tokens = out.max_tokens ?? out.max_completion_tokens;
    delete out.max_completion_tokens;
  }
  return out;
}
