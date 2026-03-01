import express from "express";
import { randomUUID } from "node:crypto";
import {
  applyCodexParityDefaults,
  clampReasoningEffort,
  sanitizeOutputText,
  toUpstreamInputContent,
  toolContentToOutput,
  asNonEmptyString,
} from "./helpers.js";

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
      choice.message.tool_calls.length > 0;
    const assistantEmptyOutput = !hasText && !hasToolCalls;

    return { assistantEmptyOutput, assistantFinishReason: finishReason };
  }

  if (payload.object === "response") {
    const outputs = Array.isArray(payload?.output) ? payload.output : [];
    const assistantMsg = outputs.find(
      (item: any) => item?.type === "message" && item?.role === "assistant",
    );
    if (!assistantMsg) return {};

    const contentParts = Array.isArray(assistantMsg?.content)
      ? assistantMsg.content
      : [];
    const hasOutputText = contentParts.some((part) =>
      Boolean(asNonEmptyString(part?.text)),
    );
    const assistantEmptyOutput = !hasOutputText;
    const assistantFinishReason =
      asNonEmptyString(payload?.status) ??
      asNonEmptyString(payload?.stop_reason);
    return { assistantEmptyOutput, assistantFinishReason };
  }

  return {};
}

function applyCodexParityDefaults(payload: any, sessionId?: string) {
  const modelId = typeof payload?.model === "string" ? payload.model : "";
  payload.store = false;
  payload.stream = true;
  payload.tool_choice = payload.tool_choice ?? "auto";
  payload.parallel_tool_calls = payload.parallel_tool_calls ?? true;
  payload.text =
    typeof payload.text === "object" && payload.text !== null
      ? payload.text
      : {};
  payload.text.verbosity = payload.text.verbosity ?? "medium";
  if (!Array.isArray(payload.include))
    payload.include = ["reasoning.encrypted_content"];
  else if (!payload.include.includes("reasoning.encrypted_content"))
    payload.include.push("reasoning.encrypted_content");
  if (sessionId && typeof payload.prompt_cache_key === "undefined")
    payload.prompt_cache_key = sessionId;

  const instructions =
    typeof payload.instructions === "string" ? payload.instructions.trim() : "";
  if (!instructions) payload.instructions = "You are a helpful assistant.";
  else payload.instructions = instructions;

  if (typeof payload.reasoning_effort !== "undefined") {
    payload.reasoning =
      typeof payload.reasoning === "object" && payload.reasoning !== null
        ? payload.reasoning
        : {};
    payload.reasoning.effort = payload.reasoning_effort;
    delete payload.reasoning_effort;
  }
  if (
    payload.reasoning &&
    typeof payload.reasoning === "object" &&
    typeof payload.reasoning.effort === "string"
  ) {
    payload.reasoning.effort = clampReasoningEffort(
      modelId,
      payload.reasoning.effort,
    );
    if (typeof payload.reasoning.summary === "undefined")
      payload.reasoning.summary = "auto";
  }
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
