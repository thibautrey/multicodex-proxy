import assert from "node:assert/strict";
import test from "node:test";
import { providerAgentEnvironment } from "./provider-agent-supervisor.js";

test("provider agent inherits only its explicit local configuration", () => {
  const environment = providerAgentEnvironment({
    MULTIVIBE_CORE_LOOPBACK_URL: "http://127.0.0.1:1455",
    MULTIVIBE_PROVIDER_AGENT_LISTEN: "127.0.0.1:1460",
    MULTIVIBE_PROVIDER_SELECTED_MODELS: '["publisher/model"]',
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
