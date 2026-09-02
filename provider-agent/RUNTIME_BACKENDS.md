# Runtime backend contract

The provider agent contains a small, versioned Go contract for managed model
runtimes. It is an internal extension boundary, not a dynamic plugin system and
not a promise that a particular future runtime is supported.

The current contract version is `provider-runtime-backend-v1`. The workload
profile is independently versioned as `provider-runtime-workload-profile-v2`,
and normalized metrics use `provider-runtime-metrics-v1`.

## Trust and registration boundary

Backends are compiled into the provider-agent binary and passed explicitly to
`newRuntimeBackendRegistry` by `main`. The registry is immutable after
construction. It does not scan directories, load shared libraries, invoke a
plugin protocol, or accept an implementation from Cloud or local API input.

Every backend supplies a descriptor containing:

- a stable ID and deterministic priority;
- lifecycle and execution capabilities;
- supported OS, architecture and accelerator profiles;
- maximum model count, concurrency, model bytes, memory, context, command
  output and preparation durations;
- immutable relative executable paths and/or digest-pinned container images;
- fixed argument templates; and
- an HTTPS source, version and SHA-256 artifact provenance.

Descriptor views are deep copies. Runtime overrides can only disable or order
already compiled backend IDs and reduce concurrency/context bounds. Their type
contains no executable, image, argument, origin or provenance replacement.
Argument templates reject shell metacharacters and recognize only the local
catalog-model placeholder. Implementations invoke argument vectors directly;
they must never concatenate a shell command.

## Workload profiles and selection

A workload profile joins three declarative inputs:

1. the exact catalog model, content and license-assessment digests, context,
   artifact size and VRAM estimate;
2. the observed accelerator profile, OS, architecture, kind and memory; and
3. the required runtime contract/capabilities plus an exact provenance pin for
   every permitted backend ID.

Selection is fail-closed and explainable. With no explicit backend order, the
registry returns exactly one primary using descriptor priority and then backend
ID. Mere compatibility never creates a fallback. When
`PreferredBackendIDs` is present, it is the complete forced primary/fallback
chain: only those named entries, in that order, can be returned. Unknown,
duplicate, disabled or profile-undeclared IDs are rejected. A named fallback
that misses a required streaming, cancellation, cleanup, hardware, memory,
context or provenance constraint is omitted rather than used as a downgrade.

`SelectExplained` reports the selected primary, explicit fallbacks, whether the
order was forced and the deterministic basis. It intentionally exposes no
paths, commands, device identifiers or local errors.

## Interface responsibilities

The `runtimeBackend` interface keeps these operations distinct:

- `Capabilities` and `Compatible` describe support without mutating state;
- `Prepare` installs or verifies the pinned runtime;
- `Load` prepares one exact catalog model;
- `Execute` and `ExecuteStream` are separate execution surfaces;
- `Cancel` targets a strict, bounded `ExecutionID`, while every operation also
  honors `context.Context` cancellation;
- `Health` and `Ready` report lifecycle state;
- `Metrics` returns normalized prefill, time-to-first-token, tokens-per-second,
  memory, concurrency, OOM, crash, timeout and cancellation counters;
- `Cleanup` releases explicitly named model/runtime state; and
- `Stop` shuts down the runtime.

Metrics must carry the metrics schema version and remain within the
descriptor's concurrency/model/memory bounds. Performance percentiles are all
absent when there are no execution samples and all present when samples exist.
OOM, crash, timeout and cancellation have stable sentinel errors/counters so a
caller does not need to parse backend-specific messages.

An implementation that advertises streaming or explicit cancellation must
also advertise execution. Execution IDs are validated before use; duplicate,
unknown and malformed IDs fail closed. A backend must not silently convert an
OOM, crash, timeout or cancellation into success or into an unrequested
fallback.

## Ollama reference adapter

`ollamaRuntimeBackend` is the reference adapter around the existing managed
Ollama controller runtime. The legacy controller surface remains a temporary
compatibility shim, with catalog and dependency-manifest paths pinned inside
the adapter.

Ollama remains preparation-only in this release:

- `shadow_only=true`;
- customer traffic is false;
- execution, streaming and execution cancellation are not advertised;
- execution calls return `errRuntimeBackendExecutionDisabled`; and
- controller views keep routing and compensation eligibility false.

Its managed runtime tree is re-attested before start. Model activation strictly
parses the pinned Ollama manifest and verifies the regular, non-symlink config
and layer blobs by declared size and SHA-256 using stable file identities.

## Adding a compiled backend

Keep a contribution narrow and reviewable:

1. implement the interface without embedding backend-specific concepts in the
   generic types;
2. define immutable launch and provenance data in code/package metadata;
3. register the concrete instance explicitly in `main`;
4. run the shared contract suite against it;
5. add adversarial tests for invalid profiles, missing metrics, OOM, crash,
   timeout, context/ID cancellation and fallback downgrade; and
6. document packaging, licenses and platform limitations without claiming
   support that has not been tested on the real hardware.

The fake backend in `runtime_backend_test.go` is test-only. It must never be
registered in a production binary.
