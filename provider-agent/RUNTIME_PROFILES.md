# Runtime profile catalog

Runtime profiles are reviewed data, not runtime commands. The v3 catalog joins
one exact model and quantization, one hardware class and one compiled runtime
adapter. It never carries an executable, argument vector, environment variable,
secret, device identifier or arbitrary network endpoint.

The canonical catalog is `packaging/provider-runtime-profiles.json`; its Draft
2020-12 schema is
`packaging/schemas/provider-runtime-profiles.schema.json`. Every object is
closed with `additionalProperties: false`. The catalog and every profile carry
SHA-256 digests. `runtimeprofile.Finalize` computes them over deterministic Go
struct encodings, and `runtimeprofile.Load` recomputes them before returning.
Changing model, runtime, hardware, tuning, licensing or provenance therefore
invalidates the reviewed digest.

## Profile dimensions

Each `provider-runtime-profile-v3` entry pins:

- canonical model ID, content digest, artifact format, quantization, byte size,
  SPDX-style license and license-assessment digest;
- hardware class, OS, architecture, accelerator kind, minimum accelerator
  memory and whether memory is unified;
- backend contract and adapter versions plus the exact runtime artifact digest;
- context, batch, parallelism, GPU offload layers, estimated memory and an
  additional memory reserve; and
- recommendation source, digest, method and license.

Byte values are integers in bytes. Selection is deterministic and fail-closed.
It first requires an exact model/content/format/quantization/hardware match and
an already-attested available runtime capability. Only a benchmark whose
hardware and required runtime settings were independently attested can then
rank compatible profiles. The current Ollama benchmark explicitly emits
`profile_compatibility_attested: false` and is diagnostic only, so the selector
rejects it even if its synthetic execution passed. Without attested benchmark
evidence, reviewed priority, memory and profile ID form the conservative stable
order. Stale profile or catalog digests, unavailable capabilities and implicit
fallbacks are rejected.

Local overrides use `provider-runtime-profile-overrides-v1`. They may require
an already reviewed profile/backend and reduce context, batch, parallelism,
offload or memory budget. They cannot add a backend, change provenance or raise
any reviewed limit. See `packaging/examples/runtime-profile-overrides.json`.

## Compatibility and contribution

`runtimeprofile.Decode` dual-reads the legacy
`provider-runtime-workload-profile-v2` shape. Migration needs explicit
`MigrationDefaults` for format, quantization, licensing, hardware class,
adapter version and every tuning value absent from v2. Missing defaults fail;
nothing is guessed. The returned artifact is a normal, digest-protected v3
catalog and records `migrated_from`.

To contribute a profile, copy the shape from the packaged catalog, cite a
credential-free HTTPS recommendation source and its digest, keep conservative
memory reserve, run `runtimeprofile.Finalize`, and add hardware-independent
selection/adversarial tests. A new profile does not register a runtime and a
runtime cannot self-advertise a profile. The compiled runtime registry remains
the trust boundary.

Ollama is the first reference runtime, not a claim of universal optimality.
Profiles for llama.cpp, vLLM, TensorRT-LLM, MLX or another compiled adapter can
use the same contract without adding backend logic to the selector. Hardware
measurements should be contributed as reviewed profiles or matching benchmark
evidence, never as an opaque auto-tuning rule.
