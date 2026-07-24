import assert from "node:assert/strict";
import test from "node:test";
import {
  buildModelsListResponse,
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
  const response = buildModelsListResponse([
    exposedModel,
    {
      id: "third-party-model",
      object: "model",
      created: 0,
      owned_by: "zai",
      metadata: { provider: "zai" },
    },
  ]);

  assert.equal(response.object, "list");
  assert.equal(response.data.length, 2);
  assert.equal("codexModelInfo" in response.data[0], false);
  assert.deepEqual(response.models, [codexModelInfo]);
});
