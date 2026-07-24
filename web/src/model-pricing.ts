export type ModelPricing = {
  inputPer1M: number;
  cachedInputPer1M?: number;
  outputPer1M: number;
  longContext?: {
    thresholdTokens: number;
    inputPer1M: number;
    cachedInputPer1M?: number;
    outputPer1M: number;
  };
};

const UNPRICED_MODELS = new Set([
  "gpt-5.3-codex-spark",
  "codex-auto-review",
]);

const EXACT_PRICING: Record<string, ModelPricing> = {
  // Standard API token rates: https://developers.openai.com/api/docs/pricing
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
  "gpt-5.2": { inputPer1M: 1.75, cachedInputPer1M: 0.175, outputPer1M: 14.0 },
  "gpt-5.2-codex": { inputPer1M: 1.75, cachedInputPer1M: 0.175, outputPer1M: 14.0 },
  "gpt-5.3-codex": { inputPer1M: 1.75, cachedInputPer1M: 0.175, outputPer1M: 14.0 },
  "gpt-5.4": {
    inputPer1M: 2.5,
    cachedInputPer1M: 0.25,
    outputPer1M: 15.0,
    longContext: { thresholdTokens: 272_000, inputPer1M: 5.0, cachedInputPer1M: 0.5, outputPer1M: 22.5 },
  },
  "gpt-5.4-mini": { inputPer1M: 0.75, cachedInputPer1M: 0.075, outputPer1M: 4.5 },
  "gpt-5.5": {
    inputPer1M: 5.0,
    cachedInputPer1M: 0.5,
    outputPer1M: 30.0,
    longContext: { thresholdTokens: 272_000, inputPer1M: 10.0, cachedInputPer1M: 1.0, outputPer1M: 45.0 },
  },
  "gpt-5.6-sol": { inputPer1M: 5.0, cachedInputPer1M: 0.5, outputPer1M: 30.0 },
  "gpt-5.6-terra": { inputPer1M: 2.5, cachedInputPer1M: 0.25, outputPer1M: 15.0 },
  "gpt-5.6-luna": { inputPer1M: 1.0, cachedInputPer1M: 0.1, outputPer1M: 6.0 },
  // Legacy names retained for historical trace estimates.
  "gpt-5.6": { inputPer1M: 5.0, cachedInputPer1M: 0.5, outputPer1M: 30.0 },
  "gpt-5.6-mini": { inputPer1M: 2.5, cachedInputPer1M: 0.25, outputPer1M: 15.0 },
  "gpt-5.6-nano": { inputPer1M: 1.0, cachedInputPer1M: 0.1, outputPer1M: 6.0 },
  "deepseek-v4-flash": { inputPer1M: 0.14, outputPer1M: 0.28 },
  "deepseek-v4-pro": { inputPer1M: 0.435, outputPer1M: 0.87 },
  "deepseek-chat": { inputPer1M: 0.14, outputPer1M: 0.28 },
  "deepseek-reasoner": { inputPer1M: 0.14, outputPer1M: 0.28 },
};

const PREFIX_PRICING: Array<{ prefix: string; pricing: ModelPricing }> = [
  { prefix: "gpt-4o-mini", pricing: { inputPer1M: 0.15, outputPer1M: 0.6 } },
  { prefix: "gpt-4o", pricing: { inputPer1M: 5.0, outputPer1M: 15.0 } },
  { prefix: "gpt-4.1-mini", pricing: { inputPer1M: 0.3, outputPer1M: 1.2 } },
  { prefix: "gpt-4.1-nano", pricing: { inputPer1M: 0.1, outputPer1M: 0.4 } },
  { prefix: "gpt-4.1", pricing: { inputPer1M: 5.0, outputPer1M: 15.0 } },
  { prefix: "gpt-5.1-codex-max", pricing: { inputPer1M: 1.25, outputPer1M: 10.0 } },
  { prefix: "gpt-5.1-codex-mini", pricing: { inputPer1M: 0.25, outputPer1M: 2.0 } },
  { prefix: "gpt-5.6-sol", pricing: EXACT_PRICING["gpt-5.6-sol"] },
  { prefix: "gpt-5.6-terra", pricing: EXACT_PRICING["gpt-5.6-terra"] },
  { prefix: "gpt-5.6-luna", pricing: EXACT_PRICING["gpt-5.6-luna"] },
  { prefix: "gpt-5.6-mini", pricing: EXACT_PRICING["gpt-5.6-mini"] },
  { prefix: "gpt-5.6-nano", pricing: EXACT_PRICING["gpt-5.6-nano"] },
  { prefix: "gpt-5.6", pricing: EXACT_PRICING["gpt-5.6"] },
  { prefix: "gpt-5.4-mini", pricing: EXACT_PRICING["gpt-5.4-mini"] },
  { prefix: "gpt-5.3-codex", pricing: EXACT_PRICING["gpt-5.3-codex"] },
  { prefix: "gpt-5.2-codex", pricing: EXACT_PRICING["gpt-5.2-codex"] },
  { prefix: "gpt-5.1-codex", pricing: { inputPer1M: 1.25, outputPer1M: 10.0 } },
  { prefix: "gpt-5-codex", pricing: { inputPer1M: 1.25, outputPer1M: 10.0 } },
  { prefix: "codex-mini-latest", pricing: { inputPer1M: 1.5, outputPer1M: 6.0 } },
  { prefix: "gpt-5", pricing: { inputPer1M: 5.0, outputPer1M: 15.0 } },
  { prefix: "deepseek-v4-flash", pricing: { inputPer1M: 0.14, outputPer1M: 0.28 } },
  { prefix: "deepseek-v4-pro", pricing: { inputPer1M: 0.435, outputPer1M: 0.87 } },
  { prefix: "deepseek-chat", pricing: { inputPer1M: 0.14, outputPer1M: 0.28 } },
  { prefix: "deepseek-reasoner", pricing: { inputPer1M: 0.14, outputPer1M: 0.28 } },
];

export function getModelPricing(model?: string): ModelPricing | undefined {
  if (!model || typeof model !== "string") return undefined;
  const m = model.trim();
  if (!m) return undefined;
  if (UNPRICED_MODELS.has(m)) return undefined;
  if (EXACT_PRICING[m]) return EXACT_PRICING[m];
  for (const entry of PREFIX_PRICING) {
    if (m.startsWith(entry.prefix)) return entry.pricing;
  }
  return undefined;
}

export function estimateCostUsd(
  model: string | undefined,
  tokensInput = 0,
  tokensOutput = 0,
  tokensInputCached = 0,
): number | undefined {
  const pricing = getModelPricing(model);
  if (!pricing) return undefined;
  const input = Math.max(0, tokensInput);
  const rate = pricing.longContext && input > pricing.longContext.thresholdTokens
    ? pricing.longContext
    : pricing;
  const cachedInput = Math.min(input, Math.max(0, tokensInputCached));
  const uncachedInput = input - cachedInput;
  const cachedInputRate = rate.cachedInputPer1M ?? rate.inputPer1M;
  const inCost = (uncachedInput / 1_000_000) * rate.inputPer1M + (cachedInput / 1_000_000) * cachedInputRate;
  const outCost = (Math.max(0, tokensOutput) / 1_000_000) * rate.outputPer1M;
  return inCost + outCost;
}
