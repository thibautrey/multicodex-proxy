export type ModelPricing = {
  inputPer1M: number;
  outputPer1M: number;
};

const EXACT_PRICING: Record<string, ModelPricing> = {
  "gpt-4o": { inputPer1M: 5.0, outputPer1M: 15.0 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4.1": { inputPer1M: 5.0, outputPer1M: 15.0 },
  "gpt-4.1-mini": { inputPer1M: 0.3, outputPer1M: 1.2 },
  "gpt-4.1-nano": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "gpt-5": { inputPer1M: 5.0, outputPer1M: 15.0 },
  "codex-mini-latest": { inputPer1M: 1.5, outputPer1M: 6.0 },
  "gpt-5-codex": { inputPer1M: 1.25, outputPer1M: 10.0 },
  "gpt-5.1-codex": { inputPer1M: 1.25, outputPer1M: 10.0 },
  "gpt-5.1-codex-max": { inputPer1M: 1.25, outputPer1M: 10.0 },
  "gpt-5.1-codex-mini": { inputPer1M: 0.25, outputPer1M: 2.0 },
  "gpt-5.2-codex": { inputPer1M: 1.75, outputPer1M: 14.0 },
  "gpt-5.3-codex": { inputPer1M: 1.75, outputPer1M: 14.0 },
};

const PREFIX_PRICING: Array<{ prefix: string; pricing: ModelPricing }> = [
  { prefix: "gpt-4o-mini", pricing: { inputPer1M: 0.15, outputPer1M: 0.6 } },
  { prefix: "gpt-4o", pricing: { inputPer1M: 5.0, outputPer1M: 15.0 } },
  { prefix: "gpt-4.1-mini", pricing: { inputPer1M: 0.3, outputPer1M: 1.2 } },
  { prefix: "gpt-4.1-nano", pricing: { inputPer1M: 0.1, outputPer1M: 0.4 } },
  { prefix: "gpt-4.1", pricing: { inputPer1M: 5.0, outputPer1M: 15.0 } },
  { prefix: "gpt-5.1-codex-max", pricing: { inputPer1M: 1.25, outputPer1M: 10.0 } },
  { prefix: "gpt-5.1-codex-mini", pricing: { inputPer1M: 0.25, outputPer1M: 2.0 } },
  { prefix: "gpt-5.3-codex", pricing: { inputPer1M: 1.75, outputPer1M: 14.0 } },
  { prefix: "gpt-5.2-codex", pricing: { inputPer1M: 1.75, outputPer1M: 14.0 } },
  { prefix: "gpt-5.1-codex", pricing: { inputPer1M: 1.25, outputPer1M: 10.0 } },
  { prefix: "gpt-5-codex", pricing: { inputPer1M: 1.25, outputPer1M: 10.0 } },
  { prefix: "codex-mini-latest", pricing: { inputPer1M: 1.5, outputPer1M: 6.0 } },
  { prefix: "gpt-5", pricing: { inputPer1M: 5.0, outputPer1M: 15.0 } },
];

export function getModelPricing(model?: string): ModelPricing | undefined {
  if (!model || typeof model !== "string") return undefined;
  const m = model.trim();
  if (!m) return undefined;
  if (EXACT_PRICING[m]) return EXACT_PRICING[m];
  for (const entry of PREFIX_PRICING) {
    if (m.startsWith(entry.prefix)) return entry.pricing;
  }
  return undefined;
}

export function estimateCostUsd(model: string | undefined, tokensInput = 0, tokensOutput = 0): number | undefined {
  const pricing = getModelPricing(model);
  if (!pricing) return undefined;
  const inCost = (Math.max(0, tokensInput) / 1_000_000) * pricing.inputPer1M;
  const outCost = (Math.max(0, tokensOutput) / 1_000_000) * pricing.outputPer1M;
  return inCost + outCost;
}
