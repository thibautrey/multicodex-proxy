# Synthetic runtime benchmark

`runtimebenchmark` is an optional local measurement harness. It has no prompt
or free-text input field. It generates public deterministic terms from seed
`7`, fixes temperature to `0`, bounds all counts and passes only those terms to
an adapter. The terms are text, not model token IDs. The result therefore
records Ollama's native `prompt_eval_count` and `eval_count` as observed token
counts instead of labelling the requested term count as tokens. Results contain
aggregate measurements and normalized failure counters; generated output and
backend error strings are discarded. Every result repeats warmup count,
synthetic term count, maximum output-token count, requested runtime settings
and per-run timeout, so its digest covers the dimensions needed to compare
like-for-like executions.

The Ollama reference records native prompt-evaluation, evaluation and total
durations. Tokens per second is `eval_count / eval_duration`; `/api/ps` polling
runs concurrently with generation and records the sampled maximum of the sum
of Ollama-reported `size_vram` values. `samples_per_run` exposes sampling
density. This is a sampled Ollama residency series, not an absolute driver VRAM
maximum. TTFT remains an event-clock observation. A non-native adapter fallback
uses `(emitted tokens - 1) / (last token - first token)` and labels its timing
source explicitly.

Execution requires `Spec.Enabled` and the CLI additionally requires `--run`.
Induced OOM needs a second programmatic gate and is not exposed by the bundled
CLI. Natural OOMs remain measured and normalized. The result store accepts only
clean absolute paths, rejects links, duplicate/unknown JSON fields and loose
permissions, writes atomically with mode `0600`, retains 32 results by default
and never exceeds 1 MiB.

The bundled reference CLI talks only to a numeric loopback HTTP address. It
rejects hostnames, LAN/public IPs, credentials, redirects, URL paths and free
prompt text. It does not accept a caller-supplied Ollama model name: it loads a
strict, bounded `provider-model-catalog.json`, matches canonical ID, content
digest, byte size, license and license assessment against the selected runtime
profile, then derives the reviewed Ollama reference. It also loads the adjacent
`provider-host-dependencies.json`, requires the profile's platform artifact
digest, rejects a profile whose OS or architecture differs from the running
CLI, verifies `/api/version` is exactly the pinned Ollama `0.33.2`, and
requires exactly one non-ambiguous `/api/tags` entry whose model, manifest
digest and byte size match the selected profile before using any runtime
endpoint. Start the bundled isolated Ollama on
`127.0.0.1:18081`, ensure the reviewed model is available there, then run on
Linux:

```sh
~/.local/lib/multivibe-host/bin/multivibe-runtime-benchmark \
  --run \
  --catalog "$HOME/.local/lib/multivibe-host/resources/provider/provider-runtime-profiles.json" \
  --model-catalog "$HOME/.local/lib/multivibe-host/resources/provider/provider-model-catalog.json" \
  --profile qwen2.5-0.5b-q4km-cuda8-ollama \
  --ollama-url http://127.0.0.1:18081 \
  --synthetic-terms 256 \
  --output-tokens 64 \
  --store "$HOME/.local/share/multivibe-host/runtime-benchmarks.json"
```

On macOS, the executable is at
`MultiVibe Host.app/Contents/Helpers/multivibe-runtime-benchmark` and the
catalog is under `Contents/Resources/provider/`. This executable is not wired
to the worker HTTP server and cannot enable customer traffic.

The `/api/version` response is only a compatibility check and `/api/tags` is a
local observation binding the benchmark to the model served on that endpoint;
neither proves the runtime binary. Runtime artifact identity remains
established by the externally attested bundle and its verified manifest.
Requested `num_ctx`, `num_batch` and `num_gpu` values are sent to Ollama. Only
the resulting context length is independently observed through `/api/ps`;
request acceptance does not prove the exact internal batch size or GPU layer
count. The harness serializes requests at parallelism one but does not attest
the server's configured capacity. `/api/ps` proves some GPU residency for the
selected model and verifies its digest, but it does not identify the exact GPU
class.

Consequently every current result says
`pass_scope: "synthetic-runtime-execution-only"` and
`profile_compatibility_attested: false`, even when `passed` is true. It is
diagnostic evidence only. `runtimeprofile.Select` rejects such a result for
compatibility or ranking; an independent hardware/runtime/settings attestation
and a reviewed attested result format would be required before a benchmark can
influence selection. External
`nvidia-smi` evidence may document the test host, but does not change the JSON
attestation flag.

Schemas and safe disabled examples live in `packaging/schemas/` and
`packaging/examples/`. The disabled example cannot start a run by itself.
