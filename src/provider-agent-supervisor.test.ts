import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  isValidProviderSelectedModelId,
  isValidProviderRuntimeEndpointInput,
  isValidProviderRelayShadowSessionRequest,
  isValidProviderCloudEnrollmentRequest,
  isValidProviderCapacityPolicy,
  PROVIDER_RUNTIME_FAMILIES,
  providerAgentBootstrapBaseUrl,
  providerAgentChildEnvironment,
  providerAgentEnvironment,
  readProviderAgentBootstrap,
  startEmbeddedProviderAgent,
} from "./provider-agent-supervisor.js";

const execFileAsync = promisify(execFile);

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
    MULTIVIBE_PROVIDER_BOOTSTRAP_FD: "9",
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
      "/data/provider-agent-capacity-policy.json",
      "https://api.multivibe.cloud",
      "/data/provider-agent-demand-plan.json",
      "/opt/multivibe/provider-model-catalog.json",
      '{"ed25519:test":"spki"}',
      "/data/provider-agent-managed",
      "/opt/multivibe/runtime/ollama",
      "/opt/multivibe/provider-host-dependencies.json",
      "/data/provider-agent-managed-planner-state.json",
      "127.0.0.1:18081",
      "0",
      "127.0.0.1:0",
      3,
    ),
    {
      MULTIVIBE_CORE_LOOPBACK_URL: "http://127.0.0.1:1455",
      MULTIVIBE_PROVIDER_STATE_PATH: "/data/provider-agent-selection.json",
      MULTIVIBE_PROVIDER_RUNTIME_STATE_PATH: "/data/provider-agent-runtime-endpoints.json",
      MULTIVIBE_PROVIDER_DEVICE_KEY_PATH: "/data/provider-agent-device-identity.json",
      MULTIVIBE_PROVIDER_ENROLLMENT_STATE_PATH: "/data/provider-agent-cloud-enrollment.json",
      MULTIVIBE_PROVIDER_CAPACITY_POLICY_PATH: "/data/provider-agent-capacity-policy.json",
      MULTIVIBE_CLOUD_API_URL: "https://api.multivibe.cloud",
      MULTIVIBE_PROVIDER_DEMAND_PLAN_PATH: "/data/provider-agent-demand-plan.json",
      MULTIVIBE_PROVIDER_MODEL_CATALOG_PATH: "/opt/multivibe/provider-model-catalog.json",
      MULTIVIBE_PROVIDER_DEMAND_TRUSTED_KEYS: '{"ed25519:test":"spki"}',
      MULTIVIBE_PROVIDER_MANAGED_ROOT: "/data/provider-agent-managed",
      MULTIVIBE_PROVIDER_BUNDLED_OLLAMA_ROOT: "/opt/multivibe/runtime/ollama",
      MULTIVIBE_PROVIDER_DEPENDENCY_MANIFEST_PATH: "/opt/multivibe/provider-host-dependencies.json",
      MULTIVIBE_PROVIDER_MANAGED_PLANNER_STATE_PATH: "/data/provider-agent-managed-planner-state.json",
      MULTIVIBE_PROVIDER_OLLAMA_LISTEN: "127.0.0.1:18081",
      MULTIVIBE_PROVIDER_CUDA_VISIBLE_DEVICES: "0",
      MULTIVIBE_PROVIDER_AGENT_LISTEN: "127.0.0.1:0",
      MULTIVIBE_PROVIDER_BOOTSTRAP_FD: "3",
      MULTIVIBE_PROVIDER_CONTROL_TOKEN: generatedControlToken,
    },
  );
});

test("provider agent bootstrap accepts one exact private-pipe announcement", async () => {
  for (const [frame, expected] of [
    ['{"protocol_version":"provider-agent-bootstrap-v1","address":"127.0.0.1:54321"}\n', "http://127.0.0.1:54321"],
    ['{"protocol_version":"provider-agent-bootstrap-v1","address":"[::1]:54322"}\n', "http://[::1]:54322"],
  ] as const) {
    assert.equal(providerAgentBootstrapBaseUrl(frame), expected);
    const pipe = new PassThrough();
    const result = readProviderAgentBootstrap(pipe);
    pipe.end(frame);
    assert.equal(await result, expected);
  }
});

test("provider agent bootstrap rejects fixed, remote, ambiguous, and secret-bearing frames", () => {
  for (const frame of [
    '{"protocol_version":"provider-agent-bootstrap-v1","address":"127.0.0.1:1460"}\n',
    '{"protocol_version":"provider-agent-bootstrap-v1","address":"127.0.0.1:0"}\n',
    '{"protocol_version":"provider-agent-bootstrap-v1","address":"0.0.0.0:54321"}\n',
    '{"protocol_version":"provider-agent-bootstrap-v1","address":"localhost:54321"}\n',
    '{"protocol_version":"provider-agent-bootstrap-v1","address":"127.0.0.1:054321"}\n',
    '{"protocol_version":"provider-agent-bootstrap-v1","address":"127.0.0.1:65536"}\n',
    '{"protocol_version":"provider-agent-bootstrap-v1","address":"127.0.0.1:54321","bearer":"secret"}\n',
    '{"protocol_version":"provider-agent-bootstrap-v1","address":"0.0.0.0:1","address":"127.0.0.1:54321"}\n',
    '{"protocol_version":"provider-agent-bootstrap-v0","address":"127.0.0.1:54321"}\n',
    '{"protocol_version":"provider-agent-bootstrap-v1","address":"127.0.0.1:54321"}\n{}\n',
    '{"protocol_version":"provider-agent-bootstrap-v1","address":"127.0.0.1:54321"}',
  ]) {
    assert.throws(() => providerAgentBootstrapBaseUrl(frame), /bootstrap/);
  }
});

test("provider agent bootstrap is not trusted until its dedicated pipe closes", async () => {
  const pipe = new PassThrough();
  const result = readProviderAgentBootstrap(pipe);
  pipe.write('{"protocol_version":"provider-agent-bootstrap-v1","address":"127.0.0.1:54321"}\n');
  const beforeClose = await Promise.race([
    result.then(() => "resolved", () => "rejected"),
    new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
  ]);
  assert.equal(beforeClose, "pending");
  pipe.end();
  assert.equal(await result, "http://127.0.0.1:54321");
});

test("provider agent bootstrap enforces a bounded frame", async () => {
  const pipe = new PassThrough();
  const result = readProviderAgentBootstrap(pipe);
  pipe.end("x".repeat(513));
  await assert.rejects(result, /too large/);
});

test("supervision never sends its bearer to a process pre-bound on 1460 and follows a restarted child", {
  timeout: 20_000,
}, async (context) => {
  let decoyRequests = 0;
  const decoy = http.createServer((_request, response) => {
    decoyRequests += 1;
    response.setHeader("content-type", "application/json");
    response.end('{"protocol_version":"provider-agent-v1","state":"detected","selected_models":[]}');
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      decoy.once("error", onError);
      decoy.listen(1460, "127.0.0.1", () => {
        decoy.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      context.skip("loopback port 1460 is already occupied by a non-test process");
      return;
    }
    throw error;
  }

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-provider-bootstrap-"));
  const binaryPath = path.join(temporaryDirectory, "bootstrap-fixture");
  const statePath = path.join(temporaryDirectory, "launch-addresses.txt");
  const providerAgentDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../provider-agent");
  let supervisor: ReturnType<typeof startEmbeddedProviderAgent> | undefined;
  try {
    await execFileAsync("go", ["build", "-o", binaryPath, "./testdata/bootstrap-fixture"], {
      cwd: providerAgentDirectory,
    });
    supervisor = startEmbeddedProviderAgent({
      enabled: true,
      binaryPath,
      statePath,
      environment: { MULTIVIBE_PROVIDER_AGENT_LISTEN: "127.0.0.1:1460" },
      restartLimit: 2,
    });

    const firstManifest = await supervisor.getManifest();
    assert.equal(firstManifest.protocol_version, "provider-agent-v1");
    const deadline = Date.now() + 8_000;
    let addresses: string[] = [];
    while (Date.now() < deadline) {
      try {
        addresses = (await fs.readFile(statePath, "utf8")).trim().split(/\s+/u).filter(Boolean);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (addresses.length >= 2) break;
      await delay(50);
    }
    assert.equal(addresses.length, 2, "the supervised child did not relaunch with a fresh bootstrap");
    assert.notEqual(addresses[0], addresses[1], "the fixture reserves the old port, so the new bind must be observed");
    for (const address of addresses) {
      assert.match(address, /^127\.0\.0\.1:[1-9][0-9]{0,4}$/u);
      assert.notEqual(address, "127.0.0.1:1460");
    }
    const secondManifest = await supervisor.getManifest();
    assert.equal(secondManifest.protocol_version, "provider-agent-v1");
    assert.equal(decoyRequests, 0, "the fixed-port decoy received a bearer-authenticated request");
  } finally {
    await supervisor?.stop();
    await new Promise<void>((resolve) => decoy.close(() => resolve()));
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("provider capacity policy requires every explicit hoster choice", () => {
  const valid = {
    schema_version: "provider-capacity-policy-state-v1",
    revision: 0,
    paused: false,
    automatic_downloads: true,
    allow_cloud_workloads: false,
    policy: {
      schema_version: "provider-capacity-policy-v1",
      gpu_utilization_percent: 70,
      gpu_vram_percent: 75,
      max_disk_bytes: 100_000_000_000,
      model_storage_path: "/data/multivibe/models",
      max_download_bytes_per_day: 20_000_000_000,
      minimum_model_residency_seconds: 21_600,
      max_model_changes_per_day: 4,
      reserve_free_disk_bytes: 10_000_000_000,
    },
  };
  assert.equal(isValidProviderCapacityPolicy(valid), true);
  assert.equal(isValidProviderCapacityPolicy({ ...valid, allow_cloud_workloads: undefined }), false);
  assert.equal(isValidProviderCapacityPolicy({ ...valid, policy: { ...valid.policy, model_storage_path: "relative" } }), false);
  assert.equal(isValidProviderCapacityPolicy({ ...valid, policy: { ...valid.policy, gpu_vram_percent: 101 } }), false);
  assert.equal(isValidProviderCapacityPolicy({ ...valid, customerTrafficAllowed: true }), false);
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
