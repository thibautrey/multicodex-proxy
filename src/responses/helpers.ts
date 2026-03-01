export const EMPTY_ASSISTANT_FALLBACK_TEXT =
  "[upstream returned no assistant output; please retry]";

export function asNonEmptyString(v: any): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

export function looksLikeInternalToolProtocolText(text: string): boolean {
  return (
    /\bassistant\s+to=functions\./i.test(text) ||
    /\bto=functions\.[a-z0-9_]+/i.test(text) ||
    /\bfunctions\.[a-z0-9_]+\b/i.test(text)
  );
}

export function looksLikeInternalPlannerText(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (/\bThe user earlier asked:/i.test(trimmed)) return true;
  if (/^\s*Now we need to reply final message/i.test(trimmed)) return true;
  if (
    /^\s*(Need to|Now run|Let's run|Use tool|Use functions|Input to tool|Command:|We'll run)\b/i.test(
      trimmed,
    )
  )
    return true;
  if (
    /^\s*(Need summary:|List commands run:|Need final instructions:)\b/i.test(
      trimmed,
    )
  )
    return true;
  if (/^\s*\[Use functions tool/i.test(trimmed)) return true;

  const markers = [
    /\bNeed to\b/i,
    /\bNow run command\b/i,
    /\bLet's run\b/i,
    /\bUse functions\b/i,
    /\bUse tool\b/i,
    /\bInput to tool\b/i,
    /\bUse functions\.[a-z0-9_]+\b/i,
    /\bCommand:\b/i,
  ];

  let hits = 0;
  for (const marker of markers) {
    if (marker.test(text)) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

export function sanitizeOutputText(text: string): string {
  if (!text) return text;
  return looksLikeInternalToolProtocolText(text) ||
    looksLikeInternalPlannerText(text)
    ? ""
    : text;
}

export function shouldExposeFunctionCallName(name: any): boolean {
  if (typeof name !== "string") return true;
  return !name.trim().toLowerCase().startsWith("functions.");
}

export function isVisibleAssistantContentPart(part: any): boolean {
  return part?.type === "output_text" || part?.type === "refusal";
}

export function clampReasoningEffort(modelId: string, effort: string): string {
  const id = modelId.includes("/") ? modelId.split("/").pop() || modelId : modelId;
  if (
    (id.startsWith("gpt-5.2") || id.startsWith("gpt-5.3")) &&
    effort === "minimal"
  )
    return "low";
  if (id === "gpt-5.1" && effort === "xhigh") return "high";
  if (id === "gpt-5.1-codex-mini")
    return effort === "high" || effort === "xhigh" ? "high" : "medium";
  return effort;
}

export function toUpstreamInputContent(content: any, role: "user" | "assistant") {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") return [{ type: textType, text: content }];
  if (Array.isArray(content)) {
    const out: any[] = [];
    for (const part of content) {
      if (typeof part === "string") out.push({ type: textType, text: part });
      else if (
        (part?.type === "text" ||
          part?.type === "input_text" ||
          part?.type === "output_text") &&
        typeof part?.text === "string"
      ) {
        out.push({ type: textType, text: part.text });
      }
    }
    return out.length ? out : [{ type: textType, text: JSON.stringify(content) }];
  }
  return [{ type: textType, text: String(content ?? "") }];
}

export function toolContentToOutput(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" && typeof part?.text === "string")
          return part.text;
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

export function applyCodexParityDefaults(payload: any, sessionId?: string) {
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
