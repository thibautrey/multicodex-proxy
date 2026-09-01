import assert from "node:assert/strict";
import test from "node:test";
import {
  isValidProviderSelectedModelId,
  providerAgentChildEnvironment,
  providerAgentEnvironment,
} from "./provider-agent-supervisor.js";

test("provider agent inherits only its explicit local configuration", () => {
  const environment = providerAgentEnvironment({
    MULTIVIBE_CORE_LOOPBACK_URL: "http://127.0.0.1:1455",
    MULTIVIBE_PROVIDER_AGENT_LISTEN: "127.0.0.1:1460",
    MULTIVIBE_PROVIDER_SELECTED_MODELS: '["publisher/model"]',
    MULTIVIBE_PROVIDER_STATE_PATH: "/must/not/be/inherited.json",
    MULTIVIBE_PROVIDER_CONTROL_TOKEN: "must-not-be-inherited-from-parent",
    STRIPE_SECRET_KEY: "must-not-cross-the-process-boundary",
    OPENAI_API_KEY: "must-not-cross-the-process-boundary",
    OAUTH_CLIENT_SECRET: "must-not-cross-the-process-boundary",
    CONTROL_PLANE_TOKEN: "must-not-cross-the-process-boundary",
    PATH: "/unneeded/search/path",
  });

  assert.deepEqual(environment, {
    MULTIVIBE_CORE_LOOPBACK_URL: "http://127.0.0.1:1455",
    MULTIVIBE_PROVIDER_AGENT_LISTEN: "127.0.0.1:1460",
    MULTIVIBE_PROVIDER_SELECTED_MODELS: '["publisher/model"]',
  });
});

test("provider agent environment omits unset allowlisted values", () => {
  assert.deepEqual(
    providerAgentEnvironment({
      MULTIVIBE_PROVIDER_AGENT_LISTEN: "[::1]:1460",
      MULTIVIBE_CORE_LOOPBACK_URL: undefined,
    }),
    { MULTIVIBE_PROVIDER_AGENT_LISTEN: "[::1]:1460" },
  );
});

test("provider agent child receives only the generated control token and explicit state path", () => {
  const generatedControlToken = "generated-process-local-control-token";
  assert.deepEqual(
    providerAgentChildEnvironment(
      {
        MULTIVIBE_CORE_LOOPBACK_URL: "http://127.0.0.1:1455",
        MULTIVIBE_PROVIDER_CONTROL_TOKEN: "parent-controlled-token",
        MULTIVIBE_PROVIDER_STATE_PATH: "/parent-controlled-state.json",
        STRIPE_SECRET_KEY: "must-not-cross-the-process-boundary",
      },
      "/data/provider-agent-selection.json",
      generatedControlToken,
    ),
    {
      MULTIVIBE_CORE_LOOPBACK_URL: "http://127.0.0.1:1455",
      MULTIVIBE_PROVIDER_STATE_PATH: "/data/provider-agent-selection.json",
      MULTIVIBE_PROVIDER_CONTROL_TOKEN: generatedControlToken,
    },
  );
});

test("provider selection model IDs match the bounded local consent contract", () => {
  for (const model of ["org/model", "model-v1", "éditeur/modèle"]) {
    assert.equal(isValidProviderSelectedModelId(model), true, model);
  }
  for (const model of [
    "", " org/model", "org/model ", "https://example.test/model", "/tmp/model",
    "C:/models/model", "127.0.0.1/model", "[::1]/model", "org/../model", "org\\model",
    `org/${"m".repeat(200)}`, "org/\u0000model",
  ]) {
    assert.equal(isValidProviderSelectedModelId(model), false, JSON.stringify(model));
  }
});
