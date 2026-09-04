/**
 * Small, deterministic request inspection used before model routing.
 *
 * Keep this module independent from Express, stores, providers, and tracing.
 * That makes it a safe characterization boundary for the Rust core migration.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export type PayloadContextInspection = {
  hasImage: boolean;
  compactionItemCount: number;
  latestCompactionIndex: number;
};

type NativePayloadInspectionModule = {
  inspectPayloadContextJson(payload: Buffer): unknown;
  classifySseFrame?: (frame: string) => unknown;
  convertChatCompletionToResponseJson?: (
    payload: Buffer,
    fallbackModel: string,
    responseId: string,
    createdAt: number,
  ) => unknown;
  tryConvertChatCompletionToResponseJson?: (
    payload: Buffer,
    fallbackModel: string,
    responseId: string,
    createdAt: number,
  ) => unknown;
};

function isNativePayloadInspectionModule(
  value: unknown,
): value is NativePayloadInspectionModule {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { inspectPayloadContextJson?: unknown })
      .inspectPayloadContextJson === "function"
  );
}

function unwrapNativePayloadInspectionModule(
  value: unknown,
): NativePayloadInspectionModule | undefined {
  if (isNativePayloadInspectionModule(value)) return value;
  if (!value || typeof value !== "object") return undefined;
  const defaultExport = (value as { default?: unknown }).default;
  return isNativePayloadInspectionModule(defaultExport)
    ? defaultExport
    : undefined;
}

const NATIVE_DISABLED_VALUES = new Set(["0", "false", "off", "no"]);

function nativeInspectionEnabled(): boolean {
  const configured = process.env.MULTIVIBE_PROXY_CORE_NATIVE?.trim().toLowerCase();
  return !configured || !NATIVE_DISABLED_VALUES.has(configured);
}

function nativeInspectionCandidates(): string[] {
  const bundledPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../native/multivibe-proxy-core.node",
  );
  const configuredPath = process.env.MULTIVIBE_PROXY_CORE_NATIVE_PATH?.trim();
  return configuredPath ? [configuredPath, bundledPath] : [bundledPath];
}

function loadNativePayloadInspection(): NativePayloadInspectionModule | undefined {
  if (!nativeInspectionEnabled()) return undefined;

  const require = createRequire(import.meta.url);
  for (const candidate of nativeInspectionCandidates()) {
    const resolved = path.resolve(candidate);
    if (!existsSync(resolved)) continue;
    try {
      const module = unwrapNativePayloadInspectionModule(require(resolved));
      if (module) return module;
    } catch {
      // A platform-specific or incompatible addon must never prevent the
      // TypeScript API from starting. The caller will use the reference path.
    }
  }
  return undefined;
}

const nativePayloadInspection = loadNativePayloadInspection();

export const nativePayloadInspectionAvailable = Boolean(nativePayloadInspection);
export const nativeRawProtocolConversionAvailable =
  typeof nativePayloadInspection?.tryConvertChatCompletionToResponseJson ===
  "function";

export function classifySseFrameTypeFromNative(
  frame: string,
): string | undefined {
  const classifier = nativePayloadInspection?.classifySseFrame;
  if (typeof classifier !== "function") return undefined;
  try {
    const value = classifier(frame);
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return undefined;
  }
}

function normalizeNativeInspection(value: unknown): PayloadContextInspection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.hasImage !== "boolean") return undefined;
  if (
    typeof candidate.compactionItemCount !== "number" ||
    !Number.isSafeInteger(candidate.compactionItemCount) ||
    candidate.compactionItemCount < 0
  ) {
    return undefined;
  }
  if (
    typeof candidate.latestCompactionIndex !== "number" ||
    !Number.isSafeInteger(candidate.latestCompactionIndex) ||
    candidate.latestCompactionIndex < -1
  ) {
    return undefined;
  }
  return {
    hasImage: candidate.hasImage,
    compactionItemCount: candidate.compactionItemCount,
    latestCompactionIndex: candidate.latestCompactionIndex,
  };
}

/**
 * Use the optional Rust implementation on the exact JSON bytes captured by
 * the body parser. `undefined` means that the addon is unavailable or failed
 * validation; callers must then use `inspectPayloadContext` on the parsed
 * object. Keeping this function opt-in avoids a second JSON parse when the
 * native artifact is not installed.
 */
export function inspectPayloadContextFromJsonBytes(
  jsonBytes: Uint8Array,
): PayloadContextInspection | undefined {
  if (!nativePayloadInspection) return undefined;
  try {
    const buffer = Buffer.isBuffer(jsonBytes)
      ? jsonBytes
      : Buffer.from(
          jsonBytes.buffer as ArrayBuffer,
          jsonBytes.byteOffset,
          jsonBytes.byteLength,
        );
    return normalizeNativeInspection(
      nativePayloadInspection.inspectPayloadContextJson(buffer),
    );
  } catch {
    return undefined;
  }
}

/**
 * Use the optional Rust protocol projection on a normalized Chat Completion.
 * The caller owns sanitization, empty-output handling, and dynamic IDs so a
 * native failure can always return to the reference TypeScript conversion.
 */
export function convertChatCompletionToResponseObjectFromNative(
  chat: unknown,
  fallbackModel: string,
  responseId: string,
  createdAt: number,
): Record<string, unknown> | undefined {
  const converter = nativePayloadInspection?.convertChatCompletionToResponseJson;
  if (typeof converter !== "function") return undefined;

  let serialized: string;
  try {
    serialized = JSON.stringify(chat);
  } catch {
    return undefined;
  }
  if (typeof serialized !== "string") return undefined;

  try {
    const value = converter(
      Buffer.from(serialized),
      fallbackModel,
      responseId,
      createdAt,
    );
    if (typeof value !== "string" || !value.trim()) return undefined;
    const parsed: unknown = JSON.parse(value);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as { object?: unknown }).object !== "response"
    ) {
      return undefined;
    }

    const response = parsed as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(response, "usage")) {
      response.usage = undefined;
    }
    if (Array.isArray(response.output)) {
      for (const item of response.output) {
        if (!item || typeof item !== "object") continue;
        const outputItem = item as Record<string, unknown>;
        if (outputItem.type !== "function_call") continue;
        const existingId = outputItem.id ?? outputItem.call_id;
        if (existingId === null || typeof existingId === "undefined") {
          const generatedId = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
          outputItem.id = generatedId;
          outputItem.call_id = generatedId;
        } else if (typeof outputItem.call_id === "undefined") {
          outputItem.call_id = existingId;
        }
      }
    }
    return response;
  } catch {
    return undefined;
  }
}

export type RawChatCompletionResponseConversion = {
  response: Record<string, unknown>;
  hasAssistantOutput: boolean;
};

/**
 * Convert an upstream Chat Completions JSON body before JavaScript parses it.
 * The native function returns an envelope so the router can keep the existing
 * empty-output retry decision without materializing the input object first.
 */
export function convertChatCompletionToResponseObjectFromJsonBytes(
  jsonBytes: Uint8Array,
  fallbackModel: string,
  responseId: string,
  createdAt: number,
): RawChatCompletionResponseConversion | undefined {
  const converter = nativePayloadInspection?.tryConvertChatCompletionToResponseJson;
  if (typeof converter !== "function") return undefined;

  try {
    const buffer = Buffer.isBuffer(jsonBytes)
      ? jsonBytes
      : Buffer.from(
          jsonBytes.buffer as ArrayBuffer,
          jsonBytes.byteOffset,
          jsonBytes.byteLength,
        );
    const value = converter(buffer, fallbackModel, responseId, createdAt);
    if (typeof value !== "string" || !value.trim()) return undefined;

    const envelope: unknown = JSON.parse(value);
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      return undefined;
    }
    const candidate = envelope as Record<string, unknown>;
    if (typeof candidate.hasAssistantOutput !== "boolean") return undefined;
    const rawResponse = candidate.response;
    if (
      !rawResponse ||
      typeof rawResponse !== "object" ||
      Array.isArray(rawResponse) ||
      (rawResponse as { object?: unknown }).object !== "response"
    ) {
      return undefined;
    }

    const response = rawResponse as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(response, "usage")) {
      response.usage = undefined;
    }
    if (Array.isArray(response.output)) {
      for (const item of response.output) {
        if (!item || typeof item !== "object") continue;
        const outputItem = item as Record<string, unknown>;
        if (outputItem.type !== "function_call") continue;
        const existingId = outputItem.id ?? outputItem.call_id;
        if (existingId === null || typeof existingId === "undefined") {
          const generatedId = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
          outputItem.id = generatedId;
          outputItem.call_id = generatedId;
        } else if (typeof outputItem.call_id === "undefined") {
          outputItem.call_id = existingId;
        }
      }
    }

    return {
      response,
      hasAssistantOutput: candidate.hasAssistantOutput,
    };
  } catch {
    return undefined;
  }
}

export function inspectPayloadContext(payload: any): PayloadContextInspection {
  let hasImage = false;
  let compactionItemCount = 0;
  let latestCompactionIndex = -1;
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const part of content) {
      const type = typeof part?.type === "string" ? part.type : "";
      if (type.includes("image")) hasImage = true;
    }
  }

  const input = Array.isArray(payload?.input) ? payload.input : [];
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    const itemType = typeof item?.type === "string" ? item.type : "";
    if (itemType.includes("image")) hasImage = true;
    if (itemType === "compaction") {
      compactionItemCount += 1;
      latestCompactionIndex = index;
    }
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const type = typeof part?.type === "string" ? part.type : "";
      if (type.includes("image")) hasImage = true;
    }
  }

  return {
    hasImage,
    compactionItemCount,
    latestCompactionIndex,
  };
}

export function payloadHasImage(payload: any): boolean {
  return inspectPayloadContext(payload).hasImage;
}
