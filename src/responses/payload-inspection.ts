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

export type PayloadContextInspection = {
  hasImage: boolean;
  compactionItemCount: number;
  latestCompactionIndex: number;
};

type NativePayloadInspectionModule = {
  inspectPayloadContextJson(payload: Buffer): unknown;
};

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
      const loaded = require(resolved) as
        | NativePayloadInspectionModule
        | { default?: NativePayloadInspectionModule };
      if (!loaded || typeof loaded !== "object") continue;
      const module =
        "default" in loaded && loaded.default ? loaded.default : loaded;
      if (typeof module.inspectPayloadContextJson === "function") return module;
    } catch {
      // A platform-specific or incompatible addon must never prevent the
      // TypeScript API from starting. The caller will use the reference path.
    }
  }
  return undefined;
}

const nativePayloadInspection = loadNativePayloadInspection();

export const nativePayloadInspectionAvailable = Boolean(nativePayloadInspection);

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
