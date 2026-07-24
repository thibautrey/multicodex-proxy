type ModelWithOptionalCodexInfo = {
  codexModelInfo?: Record<string, unknown>;
  [key: string]: unknown;
};

export function toOpenAiModelShape(model: ModelWithOptionalCodexInfo) {
  const { codexModelInfo: _codexModelInfo, ...openAiModel } = model;
  return openAiModel;
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
    models: exposedModels.flatMap((model) =>
      model.codexModelInfo ? [model.codexModelInfo] : [],
    ),
  };
}
