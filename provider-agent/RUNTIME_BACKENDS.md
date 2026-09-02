# Runtime backend contract

MultiVibe exposes a small, versioned Go SDK for managed model runtimes in
`runtimebackend`. It is an internal process boundary for statically compiled
adapters, not a dynamic plugin system and not a promise that an arbitrary
runtime can be loaded.

The current contract is `provider-runtime-backend-v1`. Runtime profiles and
normalized metrics are independently versioned as
`provider-runtime-profile-v3` and `provider-runtime-metrics-v1`.

## Trust and registration boundary

Backends are imported by the provider-agent at build time and passed as
concrete instances to an immutable registry. Neither Cloud input nor a local
directory can add code. The registry does not use `init` hooks, scan extension
folders, load shared libraries, resolve a network-provided implementation name,
or invoke an executable described by data.

The public descriptor contains only bounded, diagnostic-safe facts:

- a stable ID and deterministic priority;
- lifecycle and optional execution capabilities;
- supported OS, architecture and accelerator classes;
- model, concurrency, memory, context, input and output limits; and
- credential-free HTTPS source plus exact artifact or container digests.

It deliberately has no executable path, argument vector, image tag,
environment variable, socket, mount, secret or device identifier. A backend's
fixed launch integration remains private compiled code. Descriptor values are
deep-copied and captured once with their concrete instance, so later mutations
or descriptor permutations cannot change the registered identity.

Community packages add a `contrib.Registration` at one explicit construction
site. Their closed manifest pins the descriptor, source digest, license, file
role, mode, size and SHA-256 of the complete module-local package closure. The
verifier rejects undeclared compilable files, symlinks and replacement races,
module-local imports outside that closure, cgo, and role/extension mismatches.

## Authorization and traffic classes

Every operation receives a short-lived, process-local `OperationGrant`. Its ID
and policy revision own the resulting receipts and active executions; allowed
models and all resource ceilings are copied into the grant. Grant fields are
excluded from JSON so they cannot accidentally become a network contract or a
log payload.

The grant also carries one mandatory traffic class: `shadow` or `customer`.
Execution requests must repeat that exact class. The registry's guarded
execution surface rejects a missing or mismatched class and refuses a customer
grant unless the captured descriptor explicitly supports customer traffic and
is not shadow-only. This check happens before adapter code, including for a
backend returned by selection. Cancellation, cleanup and model receipts remain
bound to the same grant identity, revision and traffic class.

All community registrations are additionally fixed to `shadow_only=true` and
`customer_traffic=false`. Adding an adapter or profile can therefore never, by
itself, authorize customer routing, compensation or a customer-visible result.

## Profiles and deterministic selection

The reviewed v3 profile catalog joins three declarative inputs:

1. an exact model, content digest, format, quantization, license assessment,
   artifact size and context requirement;
2. a hardware class, OS, architecture, accelerator kind and memory budget; and
3. a compiled backend contract, adapter version and runtime artifact digest.

Selection first requires an exact profile, hardware, grant and attested runtime
capability match. `auto` chooses one deterministic primary and no implicit
fallback. `prefer` uses only the named compatible order as the complete
fallback chain. `require` accepts one named compatible backend. Unknown,
disabled, unreviewed, stale or provenance-mismatched candidates fail closed.

A digest-bound local synthetic benchmark may rank otherwise compatible
profiles only when its hardware and mandatory runtime settings are separately
attested. The current Ollama benchmark is explicitly diagnostic
(`profile_compatibility_attested: false`) and is rejected by the selector even
when its execution passes. Without attested evidence, reviewed priority,
memory and profile ID form the conservative stable order. Local overrides can
only require an already reviewed backend/profile or reduce context, batch,
parallelism, offload and memory ceilings.

## Interface responsibilities

The mandatory `Backend` interface keeps discovery, compatibility, preparation,
download, start, load, health, readiness, metrics, cleanup and stop distinct.
`Executor`, `StreamExecutor` and `Canceller` are optional interfaces and are
exposed by the registry only when the captured descriptor advertises them.

Inputs and outputs are bounded byte slices, excluded from JSON and redacted by
their string formatters. Metrics and errors are normalized; an adapter must not
persist or expose prompts, generated output, backend stderr, local paths or
device identifiers. OOM, crash, timeout, cancellation, expired grants and grant
mismatches use stable sentinel errors rather than backend message parsing by
callers.

The shared `runtimebackend/contracttest` suite exercises lifecycle ordering,
limits, streaming, cancellation ownership, normalized failures and cleanup.
Runtime-specific tests remain mandatory for private launch and artifact logic.

## Ollama reference bridge

The current managed Ollama bridge proves the lifecycle SDK against the existing
controller while keeping execution disabled in its descriptor. It is
`shadow_only=true`, never advertises customer traffic, and does not create a
customer routing or compensation path. Runtime `0.33.2`, its platform artifact,
model manifest and every referenced blob remain digest-pinned and re-attested.

Ollama is a reference integration, not a universal optimum. `llama.cpp`, vLLM,
TensorRT-LLM, MLX and other future adapters must pass through the same compiled
registration, grant, profile, provenance and contract-test boundaries.

See `runtimebackend/CONTRIBUTING.md`, `RUNTIME_PROFILES.md` and
`RUNTIME_BENCHMARKS.md` for the contribution, selection and measurement
contracts.
