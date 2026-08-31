import assert from "node:assert/strict";
import test from "node:test";
import {
  buildModelsListResponse,
  toCodexModelShape,
  toOpenAiModelShape,
} from "./models-response.js";

const codexModelInfo = {
  slug: "gpt-test",
  display_name: "GPT Test",
  base_instructions: "Use tools carefully.",
};

const exposedModel = {
  id: "gpt-test",
  object: "model",
  created: 0,
  owned_by: "openai",
  metadata: { provider: "openai" },
  codexModelInfo,
};

test("keeps the OpenAI model shape free of native Codex metadata", () => {
  assert.deepEqual(toOpenAiModelShape(exposedModel), {
    id: "gpt-test",
    object: "model",
    created: 0,
    owned_by: "openai",
    metadata: { provider: "openai" },
  });
});

test("serves OpenAI and Codex model catalogs in one response", () => {
  const openAiCompatibleModel = {
    id: "third-party-model",
    object: "model",
    created: 0,
    owned_by: "openai-compatible",
    metadata: { provider: "openai-compatible" },
  };

  const response = buildModelsListResponse([
    exposedModel,
    openAiCompatibleModel,
  ]);

  assert.equal(response.object, "list");
  assert.equal(response.data.length, 2);
  assert.equal("codexModelInfo" in response.data[0], false);
  assert.deepEqual(response.models, [codexModelInfo]);
});

test("adapts z.ai models to the native Codex catalog", () => {
  const zaiModel = {
    id: "glm-5.3-flash",
    object: "model" as const,
    created: 0,
    owned_by: "zai",
    metadata: {
      provider: "zai",
      supported_tool_types: ["function"],
    },
  };

  assert.deepEqual(toCodexModelShape(zaiModel), {
    slug: "glm-5.3-flash",
    display_name: "glm-5.3-flash",
    description: "z.ai model glm-5.3-flash",
    supported_reasoning_levels: [],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 100,
    support_verbosity: false,
    truncation_policy: { mode: "tokens", limit: 10000 },
  });

  const response = buildModelsListResponse([exposedModel, zaiModel]);
  assert.deepEqual(response.data[1], {
    id: "glm-5.3-flash",
    object: "model",
    created: 0,
    owned_by: "zai",
    metadata: {
      provider: "zai",
      supported_tool_types: ["function"],
    },
  });
  assert.deepEqual(response.models, [
    codexModelInfo,
    {
      slug: "glm-5.3-flash",
      display_name: "glm-5.3-flash",
      description: "z.ai model glm-5.3-flash",
      supported_reasoning_levels: [],
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: 100,
      support_verbosity: false,
      truncation_policy: { mode: "tokens", limit: 10000 },
    },
  ]);
});
