import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const evidencePath = path.join(repositoryRoot, "docs", "runtime-community-gpu-benchmark-e690aa1.evidence.json");
const expectedEvidenceFileDigest = "sha256:b5571f6015545785c3ee657e83293a6faa5cd0509dcc8dc99785be068c6e9689";
const expectedResultFileDigest = "sha256:86ab35d0f56be296e3a15a5a65af8785e266ffe5acf2e9b48bebfb34da2e12b6";
const forbiddenPayloadKeys = new Set([
  "backend_error", "completion", "completion_text", "content", "error_detail", "error_message",
  "generated_output", "input", "input_text", "message", "messages", "output", "output_text",
  "prompt", "prompt_text", "raw_output", "response", "response_text", "text",
]);

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function exactKeys(value, expected) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

function inspectRedaction(value) {
  if (Array.isArray(value)) {
    for (const entry of value) inspectRedaction(entry);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assert.ok(!forbiddenPayloadKeys.has(key.toLowerCase()), `forbidden retained payload key: ${key}`);
      inspectRedaction(entry);
    }
    return;
  }
  if (typeof value === "string") {
    assert.doesNotMatch(value, /GPU-[0-9a-f-]{16,}/iu);
    assert.doesNotMatch(value, /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu);
    assert.doesNotMatch(value, /(?:^|[^0-9])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?:$|[^0-9])/u);
    assert.doesNotMatch(value, /(?:\/mnt\/|\/home\/|\/Users\/)/u);
    assert.doesNotMatch(value, /\b(?:codex-vm|unraid)(?:\.[a-z0-9.-]+)?\b/iu);
    assert.doesNotMatch(value, /term-[0-9]{5}/u);
  }
}

test("checked-in NVIDIA benchmark evidence is digest-bound, scoped, and redacted", () => {
  const evidenceRaw = readFileSync(evidencePath);
  // Pin the exact reviewed bytes. This also makes duplicate-key or formatting changes fail closed.
  assert.equal(sha256(evidenceRaw), expectedEvidenceFileDigest);
  const evidence = JSON.parse(evidenceRaw);
  exactKeys(evidence, [
    "schema_version", "evidence_digest", "source", "provider_host_archive", "execution",
    "benchmark_result", "external_gpu_observation", "privacy", "limitations",
  ]);
  assert.equal(evidence.schema_version, "multivibe-runtime-benchmark-evidence-v1");
  const claimedEvidenceDigest = evidence.evidence_digest;
  evidence.evidence_digest = "";
  assert.equal(claimedEvidenceDigest, sha256(JSON.stringify(evidence)));

  exactKeys(evidence.source, ["repository", "commit", "tree_dirty"]);
  assert.deepEqual(evidence.source, {
    repository: "thibautrey/multivibe",
    commit: "e690aa10824aee885a493b5895e49fc8803cef3f",
    tree_dirty: false,
  });
  exactKeys(evidence.provider_host_archive, [
    "filename", "sha256", "size_bytes", "format", "version", "platform", "architecture",
    "release_ready", "runtime_checked", "host_profile",
  ]);
  assert.equal(evidence.provider_host_archive.sha256, "sha256:d80fa448e13a8a7468f78755ee1f97dd73c72e73258ad78a6f54ccdbd664a5b2");
  assert.equal(evidence.provider_host_archive.runtime_checked, true);
  assert.equal(evidence.provider_host_archive.release_ready, true);
  assert.equal(evidence.provider_host_archive.format, "ustar-gzip");
  exactKeys(evidence.execution, [
    "toolchain_image_digest", "network", "published_ports", "read_only_root_filesystem", "capabilities",
    "gpu_binding", "model_id", "model_content_digest", "model_artifact_bytes",
  ]);
  assert.equal(evidence.execution.network, "none");
  assert.equal(evidence.execution.published_ports, 0);
  assert.equal(evidence.execution.read_only_root_filesystem, true);
  assert.equal(evidence.execution.capabilities, "dropped-all");
  exactKeys(evidence.benchmark_result, [
    "path", "file_sha256", "result_digest", "requested_runs", "successful_runs", "passed",
    "pass_scope", "profile_compatibility_attested", "failures",
  ]);
  exactKeys(evidence.benchmark_result.failures, [
    "out_of_memory", "crash", "timeout", "cancelled", "protocol", "unknown",
  ]);

  const resultPath = path.join(repositoryRoot, evidence.benchmark_result.path);
  const resultRaw = readFileSync(resultPath);
  assert.equal(sha256(resultRaw), expectedResultFileDigest);
  assert.equal(sha256(resultRaw), evidence.benchmark_result.file_sha256);
  const result = JSON.parse(resultRaw);
  const claimedResultDigest = result.result_digest;
  result.result_digest = "";
  assert.equal(claimedResultDigest, sha256(JSON.stringify(result)));
  assert.equal(claimedResultDigest, evidence.benchmark_result.result_digest);
  assert.equal(result.requested_runs, evidence.benchmark_result.requested_runs);
  assert.equal(result.successful_runs, evidence.benchmark_result.successful_runs);
  assert.equal(result.passed, evidence.benchmark_result.passed);
  assert.equal(result.pass_scope, "synthetic-runtime-execution-only");
  assert.equal(evidence.benchmark_result.pass_scope, result.pass_scope);
  assert.equal(result.profile_compatibility_attested, false);
  assert.equal(evidence.benchmark_result.profile_compatibility_attested, result.profile_compatibility_attested);
  assert.deepEqual(result.failures, evidence.benchmark_result.failures);
  assert.equal(result.memory.measurement, "ollama-api-ps-size-vram-sum-sampled-during-run");
  assert.ok(result.memory.sampled_peak_bytes.minimum > 0);

  const sourceCatalogRaw = execFileSync(
    "git",
    ["show", `${evidence.source.commit}:packaging/provider-runtime-profiles.json`],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  const sourceCatalog = JSON.parse(sourceCatalogRaw);
  const sourceProfile = sourceCatalog.profiles.find((profile) => profile.id === result.profile_id);
  assert.ok(sourceProfile, "benchmark profile is absent from the source-commit catalog");
  assert.equal(result.catalog_digest, sourceCatalog.catalog_digest);
  assert.equal(result.profile_digest, sourceProfile.profile_digest);
  assert.equal(result.model_id, sourceProfile.model.id);
  assert.equal(result.model_content_digest, sourceProfile.model.content_digest);
  assert.equal(result.hardware_class, sourceProfile.hardware.class);
  assert.equal(result.runtime_id, sourceProfile.runtime.backend_id);
  assert.deepEqual(result.requested_runtime_settings, {
    context_tokens: sourceProfile.tuning.context_tokens,
    batch_size: sourceProfile.tuning.batch_size,
    parallelism: sourceProfile.tuning.parallelism,
    gpu_offload_layers: sourceProfile.tuning.gpu_offload_layers,
  });
  assert.equal(evidence.execution.model_id, result.model_id);
  assert.equal(evidence.execution.model_content_digest, result.model_content_digest);
  assert.equal(evidence.execution.model_artifact_bytes, sourceProfile.model.artifact_bytes);

  exactKeys(evidence.external_gpu_observation, [
    "device_identifier", "samples", "minimum_memory_mib", "maximum_memory_mib",
    "maximum_utilization_percent", "observed_process", "raw_sampler_retained",
  ]);
  assert.ok(evidence.external_gpu_observation.samples > 0);
  assert.ok(evidence.external_gpu_observation.minimum_memory_mib >= 0);
  assert.ok(evidence.external_gpu_observation.maximum_memory_mib >= evidence.external_gpu_observation.minimum_memory_mib);
  assert.ok(evidence.external_gpu_observation.maximum_utilization_percent >= 0);
  assert.ok(evidence.external_gpu_observation.maximum_utilization_percent <= 100);
  assert.equal(evidence.external_gpu_observation.observed_process, "bundled-ollama-llama-server");
  exactKeys(evidence.privacy, [
    "prompt_or_output_retained", "backend_error_retained", "hardware_identifier_retained",
    "hostname_or_address_retained",
  ]);
  assert.deepEqual(evidence.privacy, {
    prompt_or_output_retained: false,
    backend_error_retained: false,
    hardware_identifier_retained: false,
    hostname_or_address_retained: false,
  });
  assert.equal(evidence.external_gpu_observation.device_identifier, "omitted");
  assert.equal(evidence.external_gpu_observation.raw_sampler_retained, false);
  assert.deepEqual(evidence.limitations, [
    "Synthetic runtime execution only.",
    "Not a hardware-class or profile-compatibility attestation.",
    "Batch size and GPU offload layer count were requested but not runtime-observed.",
    "Does not prove worker enrollment, customer routing, production traffic, billing, credits, or provider payout.",
  ]);
  inspectRedaction(evidence);
  inspectRedaction(result);
});
