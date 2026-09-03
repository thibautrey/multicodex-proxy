import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderHostCapability } from "./provider-agent-supervisor.js";
import {
  createProviderWorkerEstimateClient,
  estimateProviderWorkerEarnings,
} from "./provider-worker-estimate.js";

const capability: ProviderHostCapability = {
  schema_version: "multivibe-host-capability-v1",
  agent_version: "test",
  supported: true,
  profile: "linux-nvidia",
  os: "linux",
  architecture: "amd64",
  accelerator: "cuda",
  accelerator_memory_bytes: 24 * 1024 ** 3,
  gpus: [{ name: "NVIDIA GeForce RTX 4090", memory_mib: 24_576, compute_capability: 8.9 }],
  cuda_device: 0,
};

const catalog = {
  schema_version: "provider-hardware-earnings-estimates-v1",
  currency: "USD",
  period: "month",
  generated_at: "2026-09-03T10:00:00.000Z",
  as_of_date: "2026-09-02",
  observation_window_days: 30,
  minimum_sample_size: 3,
  cohorts: [
    { profile: "linux-nvidia", accelerator: "cuda", chip: "NVIDIA GeForce RTX 4090", memory_bucket_gib: 16, estimated_monthly_usd: "170", sample_count: 7 },
    { profile: "linux-nvidia", accelerator: "cuda", chip: "NVIDIA GeForce RTX 4090", memory_bucket_gib: 24, estimated_monthly_usd: "214.75", sample_count: 8 },
  ],
  fallback: { basis: "fleet_median", estimated_monthly_usd: "91.5", sample_count: 48 },
  disclaimer: "Advisory cohort estimate only; it is not earned, payable, or guaranteed.",
};

test("local matching selects the closest same-chip cohort without uploading hardware", async () => {
  const urls: string[] = [];
  const client = createProviderWorkerEstimateClient("http://127.0.0.1:8765", async (input, init) => {
    urls.push(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(init?.body, undefined);
    return new Response(JSON.stringify(catalog), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const estimate = await client.estimate(capability);
  assert.equal(estimate.amount, "214.75");
  assert.equal(estimate.basis, "same_chip");
  assert.deepEqual(urls, ["http://127.0.0.1:8765/provider/v1/public/hardware-earnings-estimates"]);
  const requested = new URL(urls[0]!);
  assert.equal(requested.search, "");
  assert.doesNotMatch(requested.search, /4090|chip/u);
});

test("local matching uses the fleet fallback and rejects undersized cohorts", () => {
  const fallback = estimateProviderWorkerEarnings(
    { ...capability, gpus: [{ ...capability.gpus![0]!, name: "NVIDIA L4" }] },
    catalog,
  );
  assert.equal(fallback.amount, "91.50");
  assert.equal(fallback.basis, "fleet_median");
  assert.throws(() => estimateProviderWorkerEarnings(capability, {
    ...catalog,
    cohorts: [{ ...catalog.cohorts[0], sample_count: 2 }],
  }), /cohort is invalid/u);
});
