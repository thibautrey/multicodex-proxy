/**
 * Small, deterministic request inspection used before model routing.
 *
 * Keep this module independent from Express, stores, providers, and tracing.
 * That makes it a safe characterization boundary for the Rust core migration.
 */
export type PayloadContextInspection = {
  hasImage: boolean;
  compactionItemCount: number;
  latestCompactionIndex: number;
};

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
