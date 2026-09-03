import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createAdminRouter, type AdminRoutesOptions } from "./index.js";
import type {
  ProviderAgentControl,
  ProviderHostCapability,
  ProviderAgentRuntimeEndpointInput,
  ProviderCapacityPolicy,
  ProviderManagedOllamaView,
} from "../../provider-agent-supervisor.js";

function adminOptions(providerAgent: ProviderAgentControl): AdminRoutesOptions {
  return {
    store: {} as AdminRoutesOptions["store"],
    oauthStore: {} as AdminRoutesOptions["oauthStore"],
    traceManager: { pageSizeMax: 100 } as AdminRoutesOptions["traceManager"],
    codexProjectRegistry: {} as AdminRoutesOptions["codexProjectRegistry"],
    oauthConfig: {} as AdminRoutesOptions["oauthConfig"],
    openaiBaseUrl: "https://example.test",
    mistralBaseUrl: "https://example.test",
    zaiBaseUrl: "https://example.test",
    codexProjectRegistrationToken: "",
    configuredProxyApiKeys: [],
    providerAgent,
    storagePaths: {
      accountsPath: "/data/accounts.json",
      oauthStatePath: "/data/oauth.json",
      tracePath: "/data/traces.jsonl",
      traceStatsHistoryPath: "/data/trace-stats.jsonl",
      codexProjectsPath: "/data/projects.json",
    },
  };
}

async function withAdminServer(
  providerAgent: ProviderAgentControl,
  run: (baseUrl: string) => Promise<void>,
  overrides: Partial<AdminRoutesOptions> = {},
) {
  const app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter({ ...adminOptions(providerAgent), ...overrides }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function providerAgentControl(overrides: Partial<ProviderAgentControl> = {}): ProviderAgentControl {
  const unavailable = async (): Promise<never> => { throw new Error("not used"); };
  return {
    enabled: true,
    getManifest: unavailable,
    getCapability: unavailable,
    getSelection: unavailable,
    replaceSelection: unavailable,
    getAdapters: unavailable,
    getRuntimeEndpoints: unavailable,
    replaceRuntimeEndpoints: unavailable,
    detectModels: unavailable,
    getCloudEnrollment: unavailable,
    enrollCloud: unavailable,
    getCapacityPolicy: unavailable,
    replaceCapacityPolicy: unavailable,
    getDemandPlan: unavailable,
    submitSignedDemand: unavailable,
    getManagedOllamaStatus: unavailable,
    installManagedOllama: unavailable,
    startManagedOllama: unavailable,
    stopManagedOllama: unavailable,
    reconcileManagedOllama: unavailable,
    openRelayShadowSession: unavailable,
    ...overrides,
  };
}

const appleCapability = (): ProviderHostCapability => ({
  schema_version: "multivibe-host-capability-v1",
  agent_version: "test",
  supported: true,
  profile: "apple-silicon",
  os: "darwin",
  architecture: "arm64",
  accelerator: "metal",
  hardware_model: "Apple M4 Max",
  accelerator_memory_bytes: 32 * 1024 ** 3,
});

test("Host projects a supported local worker as an unconfigured non-removable provider", async () => {
  const control = providerAgentControl({
    getCapability: async () => appleCapability(),
    getManifest: async () => ({
      protocol_version: "provider-agent-v1",
      state: "detected",
      selected_models: [],
    }),
  });
  await withAdminServer(control, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/provider-agent/local-worker`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await response.json() as { localWorker: Record<string, any> };
    assert.equal(payload.localWorker.name, "MultiVibe Worker");
    assert.equal(payload.localWorker.configuration_state, "unconfigured");
    assert.equal(payload.localWorker.removable, false);
    assert.equal(payload.localWorker.routing_eligible, false);
    assert.equal(payload.localWorker.compensation_eligible, false);
    assert.equal(payload.localWorker.capability.hardware, "Apple M4 Max");
    assert.equal(payload.localWorker.estimated_monthly_earnings.amount, "184.25");
    assert.equal(payload.localWorker.estimated_monthly_earnings.basis, "same_chip");
    assert.equal(payload.localWorker.connect_url, "https://app.multivibe.cloud/earnings");
  }, {
    hostApplication: true,
    providerWorkerEstimateClient: {
      async estimate(capability) {
        assert.equal(capability.hardware_model, "Apple M4 Max");
        return {
          currency: "USD", period: "month", amount: "184.25", basis: "same_chip",
          sample_count: 12, as_of_date: "2026-09-02", disclaimer: "Advisory and not payable.",
        };
      },
    },
  });
});

test("local worker projection is absent outside Host and for unsupported hosting hardware", async () => {
  let capabilityCalls = 0;
  const control = providerAgentControl({
    getCapability: async () => {
      capabilityCalls += 1;
      return { ...appleCapability(), supported: false, profile: "intel-mac", architecture: "amd64" };
    },
  });
  await withAdminServer(control, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/provider-agent/local-worker`);
    assert.deepEqual(await response.json(), { localWorker: null });
    assert.equal(capabilityCalls, 0);
  });
  await withAdminServer(control, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/provider-agent/local-worker`);
    assert.deepEqual(await response.json(), { localWorker: null });
    assert.equal(capabilityCalls, 1);
  }, { hostApplication: true });
});

const capacityPolicy = (): ProviderCapacityPolicy => ({
  schema_version: "provider-capacity-policy-state-v1",
  revision: 1,
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
});

const managedOllamaView = (): ProviderManagedOllamaView => ({
  schema_version: "provider-managed-controller-view-v1",
  state: "ready-shadow",
  head_generation: 7,
  head_envelope_digest: "a".repeat(64),
  applied_generation: 7,
  applied_envelope_digest: "a".repeat(64),
  applied_policy_revision: 3,
  policy_revision: 3,
  selected_model_ids: ["hf:qwen/qwen2.5-0.5b-instruct"],
  shadow_only: true,
  customer_traffic_allowed: false,
  routing_eligible: false,
  compensation_eligible: false,
  runtime: {
    schema_version: "managed-ollama-status-v1",
    state: "running",
    version: "0.33.2",
    platform: "linux-amd64",
    runtime_installed: true,
    running: true,
    paused: false,
    installed_model_ids: ["hf:qwen/qwen2.5-0.5b-instruct"],
  },
});

test("admin managed Ollama actions preserve exact revision fences and shadow-only locks", async () => {
  const received: unknown[] = [];
  const control = providerAgentControl({
    getManagedOllamaStatus: async () => managedOllamaView(),
    installManagedOllama: async (policyRevision) => { received.push(["install", policyRevision]); return managedOllamaView(); },
    startManagedOllama: async (policyRevision) => { received.push(["start", policyRevision]); return managedOllamaView(); },
    stopManagedOllama: async () => { received.push(["stop"]); return managedOllamaView(); },
    reconcileManagedOllama: async (fence) => { received.push(["reconcile", fence]); return managedOllamaView(); },
  });
  await withAdminServer(control, async (baseUrl) => {
    const status = await fetch(`${baseUrl}/admin/provider-agent/managed-ollama/status`);
    assert.equal(status.status, 200);
    assert.equal((await status.json() as ProviderManagedOllamaView).customer_traffic_allowed, false);

    for (const [action, body] of [
      ["install", { policy_revision: 3 }],
      ["start", { policy_revision: 3 }],
      ["stop", {}],
      ["reconcile", { policy_revision: 3, plan_generation: 7, envelope_digest: "a".repeat(64) }],
    ] as const) {
      const response = await fetch(`${baseUrl}/admin/provider-agent/managed-ollama/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, action);
      assert.equal((await response.json() as ProviderManagedOllamaView).routing_eligible, false);
    }
    assert.deepEqual(received, [
      ["install", 3],
      ["start", 3],
      ["stop"],
      ["reconcile", { policy_revision: 3, plan_generation: 7, envelope_digest: "a".repeat(64) }],
    ]);

    const invalid = await fetch(`${baseUrl}/admin/provider-agent/managed-ollama/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy_revision: 3, plan_generation: 7, envelope_digest: "test-key", routing_eligible: true }),
    });
    assert.equal(invalid.status, 400);
  });
});

test("admin capacity policy preserves explicit local consent and revision fencing", async () => {
  let received: ProviderCapacityPolicy | undefined;
  const control = providerAgentControl({
    getCapacityPolicy: async () => capacityPolicy(),
    replaceCapacityPolicy: async (policy) => {
      received = policy;
      return { conflict: false, policy: { ...policy, revision: policy.revision + 1 } };
    },
  });
  await withAdminServer(control, async (baseUrl) => {
    const current = await fetch(`${baseUrl}/admin/provider-agent/capacity-policy`);
    assert.equal(current.status, 200);
    assert.equal((await current.json() as ProviderCapacityPolicy).allow_cloud_workloads, false);

    const input = capacityPolicy();
    const saved = await fetch(`${baseUrl}/admin/provider-agent/capacity-policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    assert.equal(saved.status, 200);
    assert.equal(received?.policy.model_storage_path, "/data/multivibe/models");
    assert.equal((await saved.json() as ProviderCapacityPolicy).revision, 2);

    const denied = await fetch(`${baseUrl}/admin/provider-agent/capacity-policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, allow_cloud_workloads: undefined }),
    });
    assert.equal(denied.status, 400);
  });
});

test("admin demand shadow forwards only a bounded signed envelope and exposes the accepted plan", async () => {
  const envelope = {
    envelopeVersion: "multivibe-provider-demand-envelope-v1",
    kind: "provider_demand_snapshot",
    payload: { kind: "provider_demand_snapshot" },
    signature: { algorithm: "Ed25519", keyId: "ed25519:test", value: "signature" },
  };
  const plan = {
    schema_version: "provider-demand-plan-state-v1" as const,
    generation: 7,
    envelope_digest: "a".repeat(64),
    signing_key_id: "ed25519:test",
    accepted_at: "2026-09-02T12:00:00.000Z",
    plan: {
      schema_version: "provider-model-plan-v1" as const,
      demand_revision: 7,
      model_storage_path: "/data/multivibe/models",
      selected_model_ids: [],
      downloads: [],
      gpu_utilization_percent: 0,
      gpu_vram_bytes: 0,
      additional_disk_bytes: 0,
      model_change: false,
      model_change_deferred: false,
      constraints: [],
    },
  };
  let forwarded: Record<string, unknown> | undefined;
  const control = providerAgentControl({
    getDemandPlan: async () => plan,
    submitSignedDemand: async (value) => {
      forwarded = value;
      return { duplicate: false, plan };
    },
  });
  await withAdminServer(control, async (baseUrl) => {
    const submitted = await fetch(`${baseUrl}/admin/provider-agent/cloud-shadow/demand`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    assert.equal(submitted.status, 201);
    assert.deepEqual(forwarded, envelope);
    assert.equal((await submitted.json() as typeof plan).generation, 7);

    const current = await fetch(`${baseUrl}/admin/provider-agent/cloud-shadow/demand-plan`);
    assert.equal(current.status, 200);
    assert.equal((await current.json() as typeof plan).envelope_digest, "a".repeat(64));

    const invalid = await fetch(`${baseUrl}/admin/provider-agent/cloud-shadow/demand`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]",
    });
    assert.equal(invalid.status, 400);
  });
});

test("admin runtime routes return registry and secret-free endpoint views", async () => {
  const control = providerAgentControl({
    getAdapters: async () => ({
      schema_version: "provider-runtime-registry-v2",
      adapters: [{
        id: "vllm",
        display_name: "vLLM",
        protocol: "openai-compatible",
        authentication: "optional-bearer",
        automatic_loopback_candidates: [],
      }],
    }),
    getRuntimeEndpoints: async () => ({
      schema_version: "provider-runtime-endpoints-v1",
      revision: 4,
      endpoints: [{
        adapter_id: "vllm",
        endpoint: "http://127.0.0.1:8000",
        authentication: "bearer",
      }],
    }),
  });
  await withAdminServer(control, async (baseUrl) => {
    const adapters = await fetch(`${baseUrl}/admin/provider-agent/adapters`);
    assert.equal(adapters.status, 200);
    assert.equal((await adapters.json() as { adapters: Array<{ id: string }> }).adapters[0]?.id, "vllm");

    const endpoints = await fetch(`${baseUrl}/admin/provider-agent/runtime-endpoints`);
    const body = await endpoints.text();
    assert.equal(endpoints.status, 200);
    assert.equal(endpoints.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(body, /bearer_token|local-secret/);
    assert.match(body, /"authentication":"bearer"/);
  });
});

test("admin runtime replacement validates targets and forwards an accepted bearer once", async () => {
  const received: ProviderAgentRuntimeEndpointInput[][] = [];
  const control = providerAgentControl({
    replaceRuntimeEndpoints: async (_revision, endpoints) => {
      received.push(endpoints);
      return {
        conflict: false,
        endpoints: {
          schema_version: "provider-runtime-endpoints-v1",
          revision: 2,
          endpoints: endpoints.map((endpoint) => ({
            adapter_id: endpoint.adapter_id,
            endpoint: endpoint.endpoint,
            authentication: endpoint.bearer_token ? "bearer" as const : "none" as const,
          })),
        },
      };
    },
  });
  await withAdminServer(control, async (baseUrl) => {
    const accepted = await fetch(`${baseUrl}/admin/provider-agent/runtime-endpoints`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: 1,
        endpoints: [{
          adapter_id: "vllm",
          endpoint: "http://127.0.0.1:8000",
          bearer_token: "local-secret",
        }],
      }),
    });
    const acceptedBody = await accepted.text();
    assert.equal(accepted.status, 200);
    assert.equal(received[0]?.[0]?.bearer_token, "local-secret");
    assert.doesNotMatch(acceptedBody, /local-secret|bearer_token/);

    for (const input of [
      { adapter_id: "vllm", endpoint: "http://192.168.1.10:8000" },
      { adapter_id: "vllm", endpoint: "http://127.0.0.1:8000/v1" },
      { adapter_id: "vllm", endpoint: "http://user:secret@127.0.0.1:8000" },
    ]) {
      const denied = await fetch(`${baseUrl}/admin/provider-agent/runtime-endpoints`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: 1, endpoints: [input] }),
      });
      assert.equal(denied.status, 400, input.endpoint);
    }
    assert.equal(received.length, 1);
  });
});

test("admin runtime replacement returns the current revision on conflict", async () => {
  const control = providerAgentControl({
    replaceRuntimeEndpoints: async () => ({
      conflict: true,
      endpoints: {
        schema_version: "provider-runtime-endpoints-v1",
        revision: 9,
        endpoints: [],
      },
    }),
  });
  await withAdminServer(control, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/provider-agent/runtime-endpoints`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, endpoints: [] }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { revision: number }).revision, 9);
  });
});

test("admin relay shadow route signs only bounded non-commercial session opens", async () => {
  let calls = 0;
  const control = providerAgentControl({
    getManifest: async () => ({
      protocol_version: "provider-agent-v1",
      state: "selected",
      selected_models: ["publisher/model"],
      device_key_id: `ed25519:${"a".repeat(43)}`,
      device_public_key_spki: "public-key-only",
    }),
    openRelayShadowSession: async () => {
      calls += 1;
      return {
        envelopeVersion: "multivibe-provider-relay-envelope-v1",
        kind: "relay_session_open",
        payload: {
          shadowOnly: true,
          customerTrafficAllowed: false,
          routingEligible: false,
          compensationEligible: false,
        },
        signature: { algorithm: "Ed25519", keyId: `ed25519:${"a".repeat(43)}`, value: "signature" },
      };
    },
  });
  await withAdminServer(control, async (baseUrl) => {
    const manifest = await fetch(`${baseUrl}/admin/provider-agent/manifest`);
    assert.equal(manifest.status, 200);
    assert.doesNotMatch(await manifest.text(), /private_key|privateKey/);

    const request = {
      session_id: "session-1",
      organization_id: "organization-1",
      provider_id: "provider-1",
      node_id: "node-1",
      credential_epoch: 2,
      relay_id: "relay-eu-1",
      region: "eu",
      transport: "outbound_mtls",
    };
    const accepted = await fetch(`${baseUrl}/admin/provider-agent/relay-shadow/session-open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(accepted.status, 200);
    const envelope = await accepted.json() as { payload: Record<string, boolean> };
    assert.equal(envelope.payload.shadowOnly, true);
    assert.equal(envelope.payload.customerTrafficAllowed, false);
    assert.equal(envelope.payload.routingEligible, false);
    assert.equal(envelope.payload.compensationEligible, false);

    const denied = await fetch(`${baseUrl}/admin/provider-agent/relay-shadow/session-open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, customerTrafficAllowed: true }),
    });
    assert.equal(denied.status, 400);
    assert.equal(calls, 1);
  });
});

test("admin Cloud enrollment forwards explicit consent once and never returns the grant", async () => {
  const grant = `mve_${"a".repeat(43)}`;
  let receivedGrant = "";
  const view = {
    schema_version: "provider-cloud-enrollment-v1" as const,
    revision: 1 as const,
    state: "submitted" as const,
    provider_id: "10000000-0000-4000-8000-000000000001",
    node_id: "20000000-0000-4000-8000-000000000002",
    device_key_id: `ed25519:${"b".repeat(43)}`,
    credential_epoch: 1,
    manifest_digest: "c".repeat(64),
    runtime_family: "omlx" as const,
    declared_max_concurrency: 4,
    cloud_api_origin: "https://api.multivibe.cloud",
    submitted_at: "2026-09-02T12:00:00.000Z",
    routing_eligible: false as const,
    compensation_eligible: false as const,
    safety_profile: "shadow_only_no_routing_no_compensation" as const,
  };
  const control = providerAgentControl({
    getCloudEnrollment: async () => view,
    enrollCloud: async (request) => {
      receivedGrant = request.enrollment_token;
      return view;
    },
  });
  await withAdminServer(control, async (baseUrl) => {
    const request = {
      enrollment_token: grant,
      core_version: "0.2.0",
      runtime_family: "omlx",
      selected_models: [{ reported_id: "publisher/model", modalities: ["text"] }],
      declared_max_concurrency: 4,
    };
    const enrolled = await fetch(`${baseUrl}/admin/provider-agent/cloud-shadow/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const body = await enrolled.text();
    assert.equal(enrolled.status, 201);
    assert.equal(receivedGrant, grant);
    assert.doesNotMatch(body, /mve_|enrollment_token/);
    assert.match(body, /"state":"submitted"/);
    assert.match(body, /"routing_eligible":false/);

    const status = await fetch(`${baseUrl}/admin/provider-agent/cloud-shadow/enrollment`);
    assert.equal(status.status, 200);

    const invalid = await fetch(`${baseUrl}/admin/provider-agent/cloud-shadow/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, selected_models: [{ reported_id: "publisher/model", modalities: ["text", "text"] }] }),
    });
    assert.equal(invalid.status, 400);
  });
});

test("the macOS handoff derives the selected runtime and submits the local key flow automatically", async () => {
  const grant = `mve_${"h".repeat(43)}`;
  let received: unknown;
  const view = {
    schema_version: "provider-cloud-enrollment-v1" as const,
    revision: 1 as const,
    state: "submitted" as const,
    provider_id: "10000000-0000-4000-8000-000000000001",
    node_id: "20000000-0000-4000-8000-000000000002",
    device_key_id: `ed25519:${"b".repeat(43)}`,
    credential_epoch: 1,
    manifest_digest: "c".repeat(64),
    runtime_family: "omlx" as const,
    declared_max_concurrency: 1,
    cloud_api_origin: "https://api.multivibe.cloud",
    submitted_at: "2026-09-03T20:00:00.000Z",
    routing_eligible: false as const,
    compensation_eligible: false as const,
    safety_profile: "shadow_only_no_routing_no_compensation" as const,
  };
  const control = providerAgentControl({
    getManifest: async () => ({
      protocol_version: "provider-agent-v1",
      state: "selected",
      selected_models: ["Qwen3.8-27B-4bit"],
      device_key_id: `ed25519:${"b".repeat(43)}`,
      device_public_key_spki: "public-only",
    }),
    detectModels: async () => ({
      schema_version: "provider-detected-models-v1",
      runtimes: [
        { adapter_id: "lm-studio", models: ["another-model"] },
        { adapter_id: "omlx", models: ["Qwen3.8-27B-4bit"] },
      ],
    }),
    enrollCloud: async (request) => {
      received = request;
      return view;
    },
  });
  await withAdminServer(control, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/provider-agent/cloud-shadow/enroll-handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enrollment_token: grant }),
    });
    const body = await response.text();
    assert.equal(response.status, 201);
    assert.deepEqual(received, {
      enrollment_token: grant,
      core_version: "0.2.0",
      runtime_family: "omlx",
      selected_models: [{ reported_id: "Qwen3.8-27B-4bit", modalities: ["text"] }],
      declared_max_concurrency: 1,
    });
    assert.doesNotMatch(body, /mve_|enrollment_token|device_public_key_spki/);
    assert.match(body, /"state":"submitted"/);
  }, { appVersion: "0.2.0" });
});

test("the macOS handoff fails closed when no single selected runtime can be proved", async () => {
  let enrollCalls = 0;
  const control = providerAgentControl({
    getManifest: async () => ({
      protocol_version: "provider-agent-v1",
      state: "selected",
      selected_models: ["shared-model"],
    }),
    detectModels: async () => ({
      schema_version: "provider-detected-models-v1",
      runtimes: [
        { adapter_id: "lm-studio", models: ["shared-model"] },
        { adapter_id: "omlx", models: ["shared-model"] },
      ],
    }),
    enrollCloud: async () => {
      enrollCalls += 1;
      throw new Error("must not enroll");
    },
  });
  await withAdminServer(control, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/provider-agent/cloud-shadow/enroll-handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enrollment_token: `mve_${"a".repeat(43)}` }),
    });
    assert.equal(response.status, 409);
    assert.equal(enrollCalls, 0);
    assert.deepEqual(await response.json(), {
      error: "provider_cloud_handoff_not_ready",
      message: "The selected local model belongs to more than one runtime",
    });
  }, { appVersion: "0.2.0" });
});
