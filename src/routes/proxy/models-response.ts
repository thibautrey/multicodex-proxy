type ModelWithOptionalCodexInfo = {
  id: string;
  codexModelInfo?: Record<string, unknown>;
  metadata?: {
    provider?: string;
  };
  [key: string]: unknown;
};

export function toOpenAiModelShape(model: ModelWithOptionalCodexInfo) {
  const { codexModelInfo: _codexModelInfo, ...openAiModel } = model;
  return openAiModel;
}

/**
 * Return the native model entry consumed by Codex CLI.
 *
 * OpenAI accounts already provide this object upstream. z.ai exposes an
 * OpenAI-compatible model list, so synthesize the small native entry Codex
 * needs to list and select the model while keeping the provider metadata out
 * of the OpenAI-compatible `data` entry.
 */
export function toCodexModelShape(model: ModelWithOptionalCodexInfo) {
  if (model.codexModelInfo) return model.codexModelInfo;
  if (model.metadata?.provider !== "zai") return undefined;

  return {
    slug: model.id,
    display_name: model.id,
    description: `z.ai model ${model.id}`,
    supported_reasoning_levels: [],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 100,
    support_verbosity: false,
  };
}

/**
 * Serve both model catalog dialects from `/v1/models`.
 *
 * OpenAI-compatible clients read `object` and `data`, while Codex CLI 0.144+
 * reads the native `models` array. Extra top-level fields are ignored by both.
 */
export function buildModelsListResponse(
  exposedModels: ModelWithOptionalCodexInfo[],
) {
  return {
    object: "list" as const,
    data: exposedModels.map(toOpenAiModelShape),
    models: exposedModels.flatMap((model) => {
      const codexModel = toCodexModelShape(model);
      return codexModel ? [codexModel] : [];
    }),
  };
}
