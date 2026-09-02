import assert from "node:assert/strict";
import test from "node:test";
import {
  isValidProviderSelectedModelId,
  isValidProviderRuntimeEndpointInput,
  isValidProviderRelayShadowSessionRequest,
  isValidProviderCloudEnrollmentRequest,
  PROVIDER_RUNTIME_FAMILIES,
  providerAgentChildEnvironment,
  providerAgentEnvironment,
} from "./provider-agent-supervisor.js";

test("provider agent inherits only its explicit local configuration", () => {
  const environment = providerAgentEnvironment({
    MULTIVIBE_CORE_LOOPBACK_URL: "http://127.0.0.1:1455",
    MULTIVIBE_PROVIDER_AGENT_LISTEN: "127.0.0.1:1460",
    MULTIVIBE_PROVIDER_SELECTED_MODELS: '["publisher/model"]',
    MULTIVIBE_PROVIDER_STATE_PATH: "/must/not/be/inherited.json",
    MULTIVIBE_PROVIDER_RUNTIME_STATE_PATH: "/must/not/be/inherited-runtime.json",
    MULTIVIBE_PROVIDER_DEVICE_KEY_PATH: "/must/not/be/inherited-device-key.json",
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

test("provider agent child receives only generated control and explicit local state paths", () => {
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
      "/data/provider-agent-runtime-endpoints.json",
      "/data/provider-agent-device-identity.json",
      "/data/provider-agent-cloud-enrollment.json",
      "https://api.multivibe.cloud",
    ),
    {
      MULTIVIBE_CORE_LOOPBACK_URL: "http://127.0.0.1:1455",
      MULTIVIBE_PROVIDER_STATE_PATH: "/data/provider-agent-selection.json",
      MULTIVIBE_PROVIDER_RUNTIME_STATE_PATH: "/data/provider-agent-runtime-endpoints.json",
      MULTIVIBE_PROVIDER_DEVICE_KEY_PATH: "/data/provider-agent-device-identity.json",
      MULTIVIBE_PROVIDER_ENROLLMENT_STATE_PATH: "/data/provider-agent-cloud-enrollment.json",
      MULTIVIBE_CLOUD_API_URL: "https://api.multivibe.cloud",
      MULTIVIBE_PROVIDER_CONTROL_TOKEN: generatedControlToken,
    },
  );
});

test("provider relay shadow requests bind exact identities and keep every commercial gate closed", () => {
  const valid = {
    session_id: "session-1",
    organization_id: "organization-1",
    provider_id: "provider-1",
    node_id: "node-1",
    credential_epoch: 2,
    relay_id: "relay-eu-1",
    region: "eu",
    transport: "outbound_mtls",
  };
  assert.equal(isValidProviderRelayShadowSessionRequest(valid), true);
  assert.equal(isValidProviderRelayShadowSessionRequest({ ...valid, transport: "public_websocket" }), false);
  assert.equal(isValidProviderRelayShadowSessionRequest({ ...valid, relay_id: "relay@example" }), false);
  assert.equal(isValidProviderRelayShadowSessionRequest({ ...valid, credential_epoch: 0 }), false);
  assert.equal(isValidProviderRelayShadowSessionRequest({ ...valid, customerTrafficAllowed: true }), false);
});

test("provider Cloud enrollment accepts only the exact explicit consent manifest", () => {
  const valid = {
    enrollment_token: `mve_${"a".repeat(43)}`,
    core_version: "0.2.0",
    runtime_family: "omlx",
    selected_models: [{ reported_id: "publisher/model", modalities: ["text"] }],
    declared_max_concurrency: 4,
  };
  assert.equal(isValidProviderCloudEnrollmentRequest(valid), true);
  for (const runtime_family of PROVIDER_RUNTIME_FAMILIES) {
    assert.equal(isValidProviderCloudEnrollmentRequest({ ...valid, runtime_family }), true, runtime_family);
  }
  assert.equal(isValidProviderCloudEnrollmentRequest({ ...valid, runtime_family: "unknown-runtime" }), false);
  assert.equal(isValidProviderCloudEnrollmentRequest({ ...valid, enrollment_token: "secret" }), false);
  assert.equal(isValidProviderCloudEnrollmentRequest({ ...valid, selected_models: [] }), false);
  assert.equal(isValidProviderCloudEnrollmentRequest({
    ...valid,
    selected_models: [{ reported_id: "publisher/model", modalities: ["text", "text"] }],
  }), false);
  assert.equal(isValidProviderCloudEnrollmentRequest({ ...valid, routing_eligible: true }), false);
});

test("provider runtime endpoints accept only bounded literal loopback HTTP targets", () => {
  for (const endpoint of ["http://127.0.0.1:8000", "http://[::1]:8080/"]) {
    assert.equal(isValidProviderRuntimeEndpointInput({
      adapter_id: "manual-openai-compatible",
      endpoint,
      bearer_token: "local token",
    }), true, endpoint);
  }
  for (const endpoint of [
    "https://127.0.0.1:8000", "http://localhost:8000", "http://0.0.0.0:8000",
    "http://192.168.1.4:8000", "http://127.0.0.1", "http://127.0.0.1:8000/v1",
    "http://user:secret@127.0.0.1:8000", "http://127.0.0.1:8000?token=secret",
  ]) {
    assert.equal(isValidProviderRuntimeEndpointInput({
      adapter_id: "manual-openai-compatible",
      endpoint,
    }), false, endpoint);
  }
  assert.equal(isValidProviderRuntimeEndpointInput({
    adapter_id: "manual-openai-compatible",
    endpoint: "http://127.0.0.1:8000",
    bearer_token: "token\nheader",
  }), false);
  assert.equal(isValidProviderRuntimeEndpointInput({
    adapter_id: "manual-openai-compatible",
    endpoint: "http://127.0.0.1:8000",
    bearer_token: "x".repeat(4097),
  }), false);
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
