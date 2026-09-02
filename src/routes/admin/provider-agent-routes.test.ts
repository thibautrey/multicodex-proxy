import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createAdminRouter, type AdminRoutesOptions } from "./index.js";
import type {
  ProviderAgentControl,
  ProviderAgentRuntimeEndpointInput,
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
) {
  const app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter(adminOptions(providerAgent)));
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
    getSelection: unavailable,
    replaceSelection: unavailable,
    getAdapters: unavailable,
    getRuntimeEndpoints: unavailable,
    replaceRuntimeEndpoints: unavailable,
    detectModels: unavailable,
    openRelayShadowSession: unavailable,
    ...overrides,
  };
}

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
