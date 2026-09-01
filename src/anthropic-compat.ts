import type express from "express";
import { randomUUID } from "node:crypto";
import {
  CLAUDE_CODE_FAST_MODEL,
  CLAUDE_CODE_MODEL,
} from "./config.js";
import {
  serializeTraceHeaders,
  TRACE_HEADERS_FORWARD_HEADER,
  type TraceHeaderMap,
} from "./trace-headers.js";

export const CLAUDE_CODE_MODEL_ALIASES = [
  "claude-opus-4-1",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;

type HeaderSource =
  | TraceHeaderMap
  | { get(name: string): string | undefined | null };

function headerValue(headers: HeaderSource, name: string): string {
  const getter = (headers as { get?: (name: string) => string | undefined | null }).get;
  if (typeof getter === "function") {
    return String(getter.call(headers, name) ?? "");
  }
  const map = headers as TraceHeaderMap;
  const raw = map[name] ?? map[name.toLowerCase()];
  return Array.isArray(raw) ? raw.join(", ") : String(raw ?? "");
}

/** Claude Code sends both headers; requiring both avoids catching other Anthropic SDKs. */
export function isClaudeCodeRequest(headers: HeaderSource): boolean {
  return (
    /^claude-cli\//i.test(headerValue(headers, "user-agent").trim()) &&
    headerValue(headers, "x-app").trim().toLowerCase() === "cli"
  );
}

export function mapClaudeCodeModel(
  requestedModel: unknown,
  detected: boolean,
  models: { main?: string; fast?: string } = {},
): string {
  const requested =
    typeof requestedModel === "string" ? requestedModel.trim() : "";
  if (!detected || !/(?:^|[/.:])claude(?:[-./]|$)/i.test(requested)) {
    return requested;
  }
  const fast = /(?:haiku|fast)/i.test(requested);
  return fast
    ? models.fast || CLAUDE_CODE_FAST_MODEL
    : models.main || CLAUDE_CODE_MODEL;
}

export function buildClaudeCodeModelsResponse() {
  return {
    object: "list" as const,
    data: CLAUDE_CODE_MODEL_ALIASES.map((id) => ({
      id,
      object: "model" as const,
      created: 0,
      owned_by: "anthropic",
    })),
  };
}

function textFromBlocks(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n\n");
  return text || undefined;
}

function anthropicImageToResponses(part: any): any | undefined {
  if (part?.type !== "image" || !part.source) return undefined;
  if (part.source.type === "base64" && typeof part.source.data === "string") {
    const mediaType =
      typeof part.source.media_type === "string"
        ? part.source.media_type
        : "image/png";
    return {
      type: "input_image",
      image_url: `data:${mediaType};base64,${part.source.data}`,
    };
  }
  if (part.source.type === "url" && typeof part.source.url === "string") {
    return { type: "input_image", image_url: part.source.url };
  }
  return undefined;
}

function messageTextPart(part: any, role: string): any | undefined {
  if (part?.type !== "text" || typeof part.text !== "string") return undefined;
  return {
    type: role === "assistant" ? "output_text" : "input_text",
    text: part.text,
  };
}

function toolResultOutput(content: unknown): string | any[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  const converted = content.flatMap((part: any) => {
    const text = messageTextPart(part, "user");
    if (text) return [text];
    const image = anthropicImageToResponses(part);
    return image ? [image] : [];
  });
  return converted.length ? converted : JSON.stringify(content);
}

function reasoningEffort(body: any): string | undefined {
  const configured = body?.output_config?.effort;
  if (
    typeof configured === "string" &&
    ["minimal", "low", "medium", "high", "xhigh"].includes(configured)
  ) {
    return configured;
  }
  const thinking = body?.thinking;
  if (!thinking || thinking.type === "disabled") return undefined;
  const budget = Number(thinking.budget_tokens);
  if (!Number.isFinite(budget)) return "medium";
  if (budget <= 1_024) return "low";
  if (budget <= 8_192) return "medium";
  return "high";
}

export function anthropicRequestToResponses(
  body: any,
  options: { claudeCode?: boolean; mainModel?: string; fastModel?: string } = {},
) {
  const input: any[] = [];
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    const role = message?.role === "assistant" ? "assistant" : "user";
    const rawContent = Array.isArray(message?.content)
      ? message.content
      : [{ type: "text", text: String(message?.content ?? "") }];
    const messageContent: any[] = [];
    const flushMessage = () => {
      if (!messageContent.length) return;
      input.push({ role, content: messageContent.splice(0) });
    };

    for (const part of rawContent) {
      const text = messageTextPart(part, role);
      if (text) {
        messageContent.push(text);
        continue;
      }
      const image = role === "user" ? anthropicImageToResponses(part) : undefined;
      if (image) {
        messageContent.push(image);
        continue;
      }
      if (part?.type === "tool_use") {
        flushMessage();
        input.push({
          type: "function_call",
          call_id:
            typeof part.id === "string"
              ? part.id
              : `toolu_${randomUUID().replace(/-/g, "")}`,
          name: typeof part.name === "string" ? part.name : "unknown",
          arguments: JSON.stringify(part.input ?? {}),
        });
        continue;
      }
      if (part?.type === "tool_result") {
        flushMessage();
        input.push({
          type: "function_call_output",
          call_id: String(part.tool_use_id ?? ""),
          output: toolResultOutput(part.content),
        });
      }
    }
    flushMessage();
  }

  const mappedModel = mapClaudeCodeModel(body?.model, Boolean(options.claudeCode), {
    main: options.mainModel,
    fast: options.fastModel,
  });
  const payload: any = {
    model: mappedModel,
    input,
    stream: Boolean(body?.stream),
  };
  const instructions = textFromBlocks(body?.system);
  if (instructions) payload.instructions = instructions;
  if (typeof body?.max_tokens === "number") {
    payload.max_output_tokens = body.max_tokens;
  }
  if (body?.metadata && typeof body.metadata === "object") {
    payload.metadata = body.metadata;
  }
  if (Array.isArray(body?.tools)) {
    payload.tools = body.tools.map((tool: any) => ({
      type: "function",
      name: tool?.name,
      description: tool?.description,
      parameters: tool?.input_schema ?? { type: "object", properties: {} },
    }));
  }
  if (body?.tool_choice?.type === "auto") payload.tool_choice = "auto";
  if (body?.tool_choice?.type === "any") payload.tool_choice = "required";
  if (body?.tool_choice?.type === "none") payload.tool_choice = "none";
  if (body?.tool_choice?.type === "tool") {
    payload.tool_choice = { type: "function", name: body.tool_choice.name };
  }
  const effort = reasoningEffort(body);
  if (effort) payload.reasoning = { effort };
  return payload;
}

function safeJson(value: unknown, fallback: any = {}): any {
  if (typeof value !== "string") return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function usageFromResponse(response: any) {
  const usage = response?.usage ?? {};
  return {
    input_tokens: Number(usage.input_tokens ?? 0),
    output_tokens: Number(usage.output_tokens ?? 0),
    cache_creation_input_tokens: Number(
      usage.input_tokens_details?.cache_creation_tokens ?? 0,
    ),
    cache_read_input_tokens: Number(
      usage.input_tokens_details?.cached_tokens ?? 0,
    ),
  };
}

function anthropicMessageId(id: unknown): string {
  const suffix = String(id ?? randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "");
  return suffix.startsWith("msg_") ? suffix : `msg_${suffix}`;
}

function stopReason(response: any, hasToolUse: boolean): string {
  if (hasToolUse) return "tool_use";
  if (
    response?.status === "incomplete" &&
    response?.incomplete_details?.reason === "max_output_tokens"
  ) {
    return "max_tokens";
  }
  return "end_turn";
}

export function responsesObjectToAnthropicMessage(
  response: any,
  requestedModel: string,
) {
  const content: any[] = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (
          (part?.type === "output_text" || part?.type === "text") &&
          typeof part.text === "string"
        ) {
          content.push({ type: "text", text: part.text });
        }
      }
    } else if (item?.type === "function_call") {
      content.push({
        type: "tool_use",
        id: String(item.call_id ?? item.id ?? ""),
        name: String(item.name ?? "unknown"),
        input: safeJson(item.arguments, {}),
      });
    }
  }
  const hasToolUse = content.some((part) => part.type === "tool_use");
  return {
    id: anthropicMessageId(response?.id),
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: stopReason(response, hasToolUse),
    stop_sequence: null,
    usage: usageFromResponse(response),
  };
}

export function anthropicErrorEnvelope(
  status: number,
  source: any,
): { type: "error"; error: { type: string; message: string } } {
  const sourceError = source?.error ?? source;
  const message =
    typeof sourceError?.message === "string"
      ? sourceError.message
      : typeof sourceError === "string"
        ? sourceError
        : "Upstream request failed";
  let type = "api_error";
  if (status === 401 || status === 403) type = "authentication_error";
  else if (status === 429) type = "rate_limit_error";
  else if (status === 529 || status === 503) type = "overloaded_error";
  else if (status >= 400 && status < 500) type = "invalid_request_error";
  return { type: "error", error: { type, message } };
}

type AnthropicSseFrame = { event: string; data: any };

export function formatAnthropicSseFrame(frame: AnthropicSseFrame): string {
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

export class ResponsesToAnthropicSse {
  private started = false;
  private stopped = false;
  private nextBlockIndex = 0;
  private blocks = new Map<string, { index: number; kind: "text" | "tool" }>();
  private emittedKeys = new Set<string>();

  constructor(private readonly requestedModel: string) {}

  private start(response: any = {}): AnthropicSseFrame[] {
    if (this.started) return [];
    this.started = true;
    return [{
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: anthropicMessageId(response?.id),
          type: "message",
          role: "assistant",
          model: this.requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...usageFromResponse(response), output_tokens: 0 },
        },
      },
    }];
  }

  private blockKey(event: any, fallback: string): string {
    return String(event?.item_id ?? event?.item?.id ?? event?.output_index ?? fallback);
  }

  private startText(key: string): AnthropicSseFrame[] {
    if (this.blocks.has(key)) return [];
    this.emittedKeys.add(key);
    const index = this.nextBlockIndex++;
    this.blocks.set(key, { index, kind: "text" });
    return [{
      event: "content_block_start",
      data: { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    }];
  }

  private startTool(key: string, item: any): AnthropicSseFrame[] {
    if (this.blocks.has(key)) return [];
    this.emittedKeys.add(key);
    const index = this.nextBlockIndex++;
    this.blocks.set(key, { index, kind: "tool" });
    return [{
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: String(item?.call_id ?? item?.id ?? key),
          name: String(item?.name ?? "unknown"),
          input: {},
        },
      },
    }];
  }

  private stopBlock(key: string): AnthropicSseFrame[] {
    const block = this.blocks.get(key);
    if (!block) return [];
    this.blocks.delete(key);
    return [{
      event: "content_block_stop",
      data: { type: "content_block_stop", index: block.index },
    }];
  }

  consume(event: any): AnthropicSseFrame[] {
    if (!event || this.stopped) return [];
    const type = String(event.type ?? "");
    if (type === "response.created") return this.start(event.response);
    if (type === "response.output_item.added" && event.item?.type === "function_call") {
      const key = this.blockKey(event, `tool-${this.nextBlockIndex}`);
      return [...this.start(event.response), ...this.startTool(key, event.item)];
    }
    if (type === "response.output_text.delta") {
      const key = this.blockKey(event, "text-0");
      const started = [...this.start(), ...this.startText(key)];
      const block = this.blocks.get(key)!;
      return [...started, {
        event: "content_block_delta",
        data: { type: "content_block_delta", index: block.index, delta: { type: "text_delta", text: String(event.delta ?? "") } },
      }];
    }
    if (type === "response.function_call_arguments.delta") {
      const key = this.blockKey(event, `tool-${event.output_index ?? 0}`);
      const item = event.item ?? { id: key, call_id: key, name: event.name };
      const started = [...this.start(), ...this.startTool(key, item)];
      const block = this.blocks.get(key)!;
      return [...started, {
        event: "content_block_delta",
        data: { type: "content_block_delta", index: block.index, delta: { type: "input_json_delta", partial_json: String(event.delta ?? "") } },
      }];
    }
    if (type === "response.output_item.done") {
      const key = this.blockKey(event, "text-0");
      return this.stopBlock(key);
    }
    if (type === "response.content_part.done") {
      return this.stopBlock(this.blockKey(event, "text-0"));
    }
    if (type === "response.completed") return this.finish(event.response);
    if (type === "response.failed" || type === "error") {
      this.stopped = true;
      return [{
        event: "error",
        data: anthropicErrorEnvelope(502, event.response?.error ?? event.error ?? event),
      }];
    }
    return [];
  }

  finish(response: any = {}): AnthropicSseFrame[] {
    if (this.stopped) return [];
    const out = this.start(response);
    for (const [key] of [...this.blocks]) out.push(...this.stopBlock(key));
    const output = Array.isArray(response?.output) ? response.output : [];
    for (const [outputIndex, item] of output.entries()) {
      const key = String(item?.id ?? outputIndex);
      if (this.emittedKeys.has(key)) continue;
      if (item?.type === "message") {
        const text = (Array.isArray(item.content) ? item.content : [])
          .filter((part: any) => part?.type === "output_text" || part?.type === "text")
          .map((part: any) => String(part.text ?? ""))
          .join("");
        if (!text) continue;
        out.push(...this.startText(key));
        const block = this.blocks.get(key)!;
        out.push({
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: block.index,
            delta: { type: "text_delta", text },
          },
        });
        out.push(...this.stopBlock(key));
      } else if (
        item?.type === "function_call" &&
        (item?.call_id || item?.id || item?.name || item?.arguments)
      ) {
        out.push(...this.startTool(key, item));
        const block = this.blocks.get(key)!;
        const argumentsJson = String(item.arguments ?? "");
        if (argumentsJson) {
          out.push({
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: block.index,
              delta: { type: "input_json_delta", partial_json: argumentsJson },
            },
          });
        }
        out.push(...this.stopBlock(key));
      }
    }
    const hasToolUse = output
      .some((item: any) => item?.type === "function_call");
    const usage = usageFromResponse(response);
    out.push({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: stopReason(response, hasToolUse), stop_sequence: null },
        usage: { output_tokens: usage.output_tokens },
      },
    });
    out.push({ event: "message_stop", data: { type: "message_stop" } });
    this.stopped = true;
    return out;
  }
}

function parseSseFrames(buffer: string): { frames: any[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  const frames: any[] = [];
  for (const part of parts) {
    const data = part
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      frames.push(JSON.parse(data));
    } catch {
      // Ignore malformed upstream frames; a later failure/completion still closes cleanly.
    }
  }
  return { frames, rest };
}

function loopbackHeaders(req: express.Request): Record<string, string> {
  const client = isClaudeCodeRequest(req.headers)
    ? "claude-code"
    : "anthropic-compatible";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-multivibe-client": client,
    [TRACE_HEADERS_FORWARD_HEADER]: serializeTraceHeaders({
      ...req.headers,
      "x-multivibe-client": client,
    }),
  };
  const authorization = req.header("authorization");
  const apiKey = req.header("x-api-key");
  if (authorization) headers.authorization = authorization;
  if (apiKey) headers["x-api-key"] = apiKey;
  for (const name of [
    "x-multivibe-priority",
    "x-multivibe-execution",
    "x-multivibe-max-wait-ms",
    "x-multivibe-deadline",
    "x-multivibe-webhook",
    "x-multivibe-internal-token",
    "x-multivibe-internal-application",
    "x-multivibe-internal-job",
  ]) {
    const value = req.header(name);
    if (value) headers[name] = value;
  }
  return headers;
}

export async function handleAnthropicMessages(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const requestedModel =
    typeof req.body?.model === "string" ? req.body.model : "claude-sonnet-4-5";
  const body = anthropicRequestToResponses(req.body, {
    claudeCode: isClaudeCodeRequest(req.headers),
  });
  const port = req.socket.localPort;
  if (!port) {
    res.status(500).json(anthropicErrorEnvelope(500, "Local proxy port unavailable"));
    return;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: loopbackHeaders(req),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10 * 60_000),
    });
  } catch (error: any) {
    res.status(502).json(anthropicErrorEnvelope(502, error));
    return;
  }

  for (const name of [
    "x-multivibe-decision",
    "x-multivibe-priority",
    "x-multivibe-resolved-model",
    "x-multivibe-estimated-wait-ms",
    "x-multivibe-capacity-version",
    "retry-after",
  ]) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }

  if (!upstream.ok) {
    const raw = await upstream.text();
    res.status(upstream.status).json(
      anthropicErrorEnvelope(upstream.status, safeJson(raw, raw)),
    );
    return;
  }

  if (!body.stream) {
    const raw = await upstream.text();
    const parsed = safeJson(raw, null);
    if (!parsed) {
      res.status(502).json(anthropicErrorEnvelope(502, "Invalid Responses payload"));
      return;
    }
    res.json(responsesObjectToAnthropicMessage(parsed, requestedModel));
    return;
  }

  res.status(200);
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders();
  const converter = new ResponsesToAnthropicSse(requestedModel);
  let buffered = "";
  if (upstream.body) {
    const decoder = new TextDecoder();
    for await (const chunk of upstream.body as any) {
      buffered += decoder.decode(chunk, { stream: true });
      const parsed = parseSseFrames(buffered);
      buffered = parsed.rest;
      for (const event of parsed.frames) {
        for (const frame of converter.consume(event)) {
          res.write(formatAnthropicSseFrame(frame));
        }
      }
    }
    buffered += decoder.decode();
    const parsed = parseSseFrames(`${buffered}\n\n`);
    for (const event of parsed.frames) {
      for (const frame of converter.consume(event)) {
        res.write(formatAnthropicSseFrame(frame));
      }
    }
  }
  for (const frame of converter.finish()) res.write(formatAnthropicSseFrame(frame));
  res.end();
}
