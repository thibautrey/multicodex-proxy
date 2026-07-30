import type {
  ResponseStreamDiagnostics,
} from "../traces.js";

export function createResponseStreamDiagnostics(): ResponseStreamDiagnostics {
  return {
    eventCount: 0,
    eventTypes: {},
    customToolCalls: [],
    invalidDataPayloadCount: 0,
    outputTextDeltaCount: 0,
    outputTextDoneCount: 0,
    reasoningEventCount: 0,
    refusalEventCount: 0,
    functionCallCount: 0,
    hiddenFunctionCallCount: 0,
    sanitizerDroppedEventCount: 0,
    sanitizerDroppedTextEventCount: 0,
    sawResponseCompleted: false,
    sawChatCompletionChunk: false,
  };
}

function customToolCallKey(event: any): string | undefined {
  const itemId = event?.item_id ?? event?.item?.id;
  const callId = event?.call_id ?? event?.item?.call_id;
  const key = itemId ?? callId;
  return typeof key === "string" && key ? key : undefined;
}

function inspectCustomToolCallEvent(
  event: any,
  type: string,
  diagnostics: ResponseStreamDiagnostics,
): void {
  const item = event?.item ?? {};
  const isCustomToolItem = item?.type === "custom_tool_call";
  const isCustomToolEvent = type.startsWith("response.custom_tool_call_");
  if (!isCustomToolItem && !isCustomToolEvent) return;

  const key = customToolCallKey(event);
  let tool = key
    ? diagnostics.customToolCalls.find((entry: any) => entry._key === key)
    : undefined;
  if (!tool && diagnostics.customToolCalls.length < 8) {
    tool = {
      itemIdPresent: typeof (event?.item_id ?? item?.id) === "string",
      callIdPresent: typeof (event?.call_id ?? item?.call_id) === "string",
      name:
        typeof (event?.name ?? item?.name) === "string"
          ? (event?.name ?? item?.name).slice(0, 120)
          : undefined,
      status:
        typeof item?.status === "string" ? item.status : undefined,
      inputDeltaCount: 0,
      inputBytes: 0,
      sawInputDone: false,
      sawOutputItemAdded: false,
      sawOutputItemDone: false,
    };
    Object.defineProperty(tool, "_key", {
      value: key ?? `anonymous-${diagnostics.customToolCalls.length + 1}`,
      enumerable: false,
    });
    diagnostics.customToolCalls.push(tool);
  }
  if (!tool) return;

  if (type === "response.output_item.added") tool.sawOutputItemAdded = true;
  if (type === "response.output_item.done") tool.sawOutputItemDone = true;
  if (type === "response.custom_tool_call_input.delta") {
    tool.inputDeltaCount += 1;
    if (typeof event?.delta === "string") {
      tool.inputBytes += Buffer.byteLength(event.delta);
    }
  }
  if (type === "response.custom_tool_call_input.done") {
    tool.sawInputDone = true;
  }
}

function inspectResponseStreamEventType(
  type: string,
  diagnostics: ResponseStreamDiagnostics,
): void {
  diagnostics.eventCount += 1;
  if (type) {
    diagnostics.eventTypes[type] = (diagnostics.eventTypes[type] ?? 0) + 1;
  }
  if (type === "response.output_text.delta") {
    diagnostics.outputTextDeltaCount += 1;
  }
  if (type === "response.output_text.done") {
    diagnostics.outputTextDoneCount += 1;
  }
  if (type.startsWith("response.reasoning")) {
    diagnostics.reasoningEventCount += 1;
  }
  if (type.startsWith("response.refusal")) {
    diagnostics.refusalEventCount += 1;
  }
  if (type === "response.completed") {
    diagnostics.sawResponseCompleted = true;
  }
}

export function inspectResponseStreamEvent(
  event: any,
  diagnostics: ResponseStreamDiagnostics,
): void {
  const type = typeof event?.type === "string" ? event.type : "";
  inspectResponseStreamEventType(type, diagnostics);
  if (event?.object === "chat.completion.chunk") {
    diagnostics.sawChatCompletionChunk = true;
  }
  inspectCustomToolCallEvent(event, type, diagnostics);

  const item = event?.item;
  if (item?.type === "function_call") {
    diagnostics.functionCallCount += 1;
    if (
      typeof item.name === "string" &&
      item.name.trim().toLowerCase().startsWith("functions.")
    ) {
      diagnostics.hiddenFunctionCallCount += 1;
    }
  }
}

function fastInspectableEventType(frame: string): string | undefined {
  let eventType: string | undefined;
  let dataPayload: string | undefined;

  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      if (dataPayload !== undefined) return undefined;
      dataPayload = line.slice(5).trim();
    }
  }
  if (!eventType || !dataPayload) return undefined;
  if (!dataPayload.startsWith("{") || !dataPayload.endsWith("}")) {
    return undefined;
  }

  const payloadType = dataPayload.match(/"type"\s*:\s*"([^"]+)"/)?.[1];
  if (payloadType !== eventType) return undefined;
  if (
    eventType === "response.output_text.delta" ||
    eventType === "response.output_text.done" ||
    eventType.startsWith("response.reasoning") ||
    eventType.startsWith("response.refusal")
  ) {
    return eventType;
  }
  return undefined;
}

export function inspectResponseStreamFrame(
  frame: string,
  diagnostics: ResponseStreamDiagnostics,
): any {
  const fastType = fastInspectableEventType(frame);
  if (fastType) {
    inspectResponseStreamEventType(fastType, diagnostics);
    return undefined;
  }

  let usage: any = undefined;
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const event = JSON.parse(payload);
      inspectResponseStreamEvent(event, diagnostics);
      if (event?.response?.usage) usage = event.response.usage;
      else if (event?.usage) usage = event.usage;
    } catch {}
  }
  return usage;
}

export function extractSSEFrameUsage(frame: string): any {
  if (!frame.includes('"usage"')) return undefined;

  let usage: any = undefined;
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]" || !payload.includes('"usage"')) {
      continue;
    }
    try {
      const event = JSON.parse(payload);
      if (event?.response?.usage) usage = event.response.usage;
      else if (event?.usage) usage = event.usage;
    } catch {}
  }
  return usage;
}
