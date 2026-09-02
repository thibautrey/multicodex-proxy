# Add a runtime to MultiVibe

Community backends are Go packages statically compiled into the worker. Every
addition is explicit and reviewable. No API loads a plugin, shared library or
sidecar, scans an extension directory, or resolves a network-provided name to
code.

## Minimal contribution path

1. Implement `runtimebackend.Backend` in a dedicated package. Implement
   `Executor`, `StreamExecutor`, and `Canceller` only when the descriptor
   advertises the corresponding capabilities.
2. Keep runtime-specific details inside the adapter. The public `Descriptor`
   never contains a local path, command, argument, environment variable,
   socket, device identifier, or secret.
3. Add a `provider-runtime-profile-v3` entry to
   `packaging/provider-runtime-profiles.json`. Record the model, format,
   quantization, hardware class, context, batch, parallelism, offload, memory
   budget, and provenance for every recommendation. The schema is
   `packaging/schemas/provider-runtime-profiles.schema.json`.
4. Add a `multivibe-runtime-contribution-v1` manifest. It binds the backend ID,
   contract version, descriptor SHA-256, source digest and license, plus the
   size, mode, role, and SHA-256 of every reviewed file.
5. Run the shared `runtimebackend/contracttest` suite and add runtime-specific
   tests for crashes, out-of-memory failures, deadlines, cancellation, and
   output limits.
6. Import the package and put its `contrib.Registration` in the single
   construction list. There is no `init` hook or mutable global registry.

The compilable `runtimebackend/exampleadapter` package demonstrates the full
cycle: discovery, compatibility, preparation, verified download, start, load,
execution, streaming, cancellation, metrics, cleanup, and stop. It is an
in-memory example and is never registered by the production worker.

```go
func TestBackendContract(t *testing.T) {
    backend, err := myruntime.New(reviewedConfig)
    if err != nil {
        t.Fatal(err)
    }
    contracttest.Run(t, backend, contracttest.DefaultFixture(time.Now()))
}
```

The explicit construction site may embed the manifest as read-only data. A
manifest does not select or load code: the concrete Go value is visible at the
call site, and `NewStaticRegistry` checks its descriptor before constructing an
immutable registry.

```go
//go:embed contribution.json
var manifestJSON []byte

manifest, err := contrib.ParseManifest(manifestJSON)
if err != nil {
    return err
}
backend, err := myruntime.New(reviewedConfig)
if err != nil {
    return err
}
registry, err := contrib.NewStaticRegistry(contrib.Registration{
    Manifest: manifest,
    Backend:  backend,
})
```

During review or packaging, `contrib.VerifyPinnedFiles` re-attests every
explicitly named file, then enumerates the complete tree of every package that
contains adapter source, native source, or contract tests. Every Go, assembly,
C-family, Fortran, syso, test, and neighboring data file must be pinned; this
also closes potential `go:embed` inputs. Traversal, symlinks, special types,
executable modes, size changes, replacement races, unpinned files, and digest
mismatches fail closed.

Build inputs cannot hide behind a data role. Non-test Go files use
`adapter_source`, `_test.go` files use `contract_test`, and native compiler,
assembler, header, SWIG, or syso inputs use `native_source`. The
`documentation`, `profile`, and `runtime_artifact` roles reject every such
extension.

The verifier parses the imports of every pinned Go file with `go/parser`, even
when a build tag excludes that file on the review host. `import "C"` is
forbidden. Production sources may rely directly on only the public
`runtimebackend` package; `_test.go` files may additionally rely on the exact
`contrib` and `contracttest` packages. Any other import below the
`github.com/thibautrey/multivibe/provider-agent/` module path must resolve to an
exact directory containing pinned production Go source. Its complete tree and
its own Go imports are then subject to the same closure. This check neither
runs `go list` nor resolves a package over the network.

The only unpinned regular file allowed in a closed package tree is the exact
`ManifestPath`. Hashing that file would create an impossible self-reference, so
the verifier instead parses its bounded bytes and requires semantic equality
with the supplied manifest. No other file-name or extension exception exists.
Root and parent directories are held through `os.OpenRoot` and rechecked by
file identity across verification.

## Launch and security boundary

An adapter may invoke only a fixed, reviewed integration in its own package. It
must never accept an executable, `argv`, image, environment variable, Docker
socket, mount, or shell command from a profile or request. When packaging an
external runtime, pin its artifacts and images in `Descriptor.Provenance`; its
private launch policy must retain closed allowlists, deadlines, bounded output,
and a secret-free environment.

Inputs, outputs, and prompts must not appear in logs, manifests, metrics, or
benchmarks. The registry rejects a declared capability without its matching Go
interface. Community `contrib.Registration` values are additionally restricted
to `ShadowOnly=true` and `CustomerTraffic=false`. Adding a backend or profile
does not authorize customer traffic: consent, network policy, and commercial
activation remain separate decisions.

Each active execution is owned by its process-local grant ID and policy
revision. Cancellation must validate the current grant and reject a request
from any other grant or policy revision; an execution ID alone is never an
authorization token.

## Packaging and licenses

Source contributions accepted into the MultiVibe provider runtime SDK,
including adapters, tests, and documentation, are contributed and distributed
under Apache-2.0 as stated in the repository `LICENSE`. By submitting a
contribution, its author agrees that Apache-2.0 applies to that contribution.
This open-source grant does not extend to separately distributed MultiVibe
Cloud services or to MultiVibe and Pleiades Solutions trademarks.

External runtime binaries, libraries, container images, and model weights are
not relicensed by their integration: each retains its own upstream license.
Their runtime and model licenses are separate controls. Before bundling an
archive, image, or model weights:

- confirm redistribution and hosted-inference rights;
- pin a version and SHA-256 or OCI digest, never a floating tag;
- preserve required notices and attribution;
- record the model license and assessment digest in its profile;
- do not confuse technical availability with commercial authorization.

A release build must verify the contribution manifest and profile catalog from
a clean checkout. Drift requires review and explicit pin updates; startup must
never rewrite them automatically.

## Ollama today, other runtimes tomorrow

Ollama is the first functional reference adapter. Its API makes the local
lifecycle convenient, but does not expose identical fine-grained control of
kernels, memory placement, batching, offload, and metrics on every platform.
MultiVibe therefore does not claim that Ollama is optimal for all hardware or
that it is the final architecture.

Future contributions remain peer backends behind the same contract:

- `llama.cpp` for GGUF, CPU/CUDA/Metal, and fine-grained offload control;
- `vLLM` for throughput, continuous batching, and Linux/GPU deployments;
- `TensorRT-LLM` for highly optimized NVIDIA paths and their build constraints;
- `MLX` for Apple Silicon and unified memory.

Selection applies model × hardware × runtime constraints first, then a local
benchmark whose digests match the catalog, and finally a conservative fallback.
A local override may only reduce reviewed values or require a compatible
backend. No opaque auto-tuning silently rewrites a profile.
