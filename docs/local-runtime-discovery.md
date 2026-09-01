# Local runtime discovery

MultiVibe can discover a supported model runtime on the same machine and add
it as an `openai-compatible` account without storing a fabricated API token.
The installer can trigger the operation through:

```http
POST /admin/local-runtimes/discover
```

The endpoint uses the existing admin authentication boundary. Replaying it is
idempotent: the LM Studio account keeps the deterministic ID
`local-runtime-lm-studio`, and a successful probe updates that account instead
of adding a duplicate.

## Supported discovery

LM Studio is currently the only automatic probe. Its official documentation
describes port `1234`, the OpenAI-compatible `/v1` base, `GET /v1/models`, and
authentication being disabled by default:

- [OpenAI compatibility endpoints](https://lmstudio.ai/docs/developer/openai-compat)
- [LM Studio authentication](https://lmstudio.ai/docs/developer/core/authentication)

The bounded adapter registry also describes Ollama, llama.cpp/llama-server/llama-cpp-python,
vLLM, SGLang, LocalAI, Hugging Face TGI and Transformers Serve, Xinference,
MLX-LM, OMLX, MLC LLM, Exo, Jan, GPT4All, KoboldCpp, text-generation-webui,
Aphrodite, TabbyAPI, llama-box, mistral.rs, NVIDIA NIM, TensorRT-LLM, Triton,
OpenLLM, BentoML, MTPLX and a manual OpenAI-compatible adapter. Each entry
declares its protocol, health and catalog contract, capabilities, authentication,
measurement units and bounded limits. Entries without a reliably identifiable
official probe remain manual and have no automatic candidates. MultiVibe does
not guess their ports or inspect processes, files, service registries, or the LAN.

Detection remains local until the user selects models. Cloud receives only the
selected model identifiers and the metadata allowlist shown before consent.

## Network and authentication boundary

Automatic probes are limited to these literal URLs, in order:

1. `http://127.0.0.1:1234/v1/models`
2. `http://[::1]:1234/v1/models`

The probe has a deadline, a bounded response size, manual redirect handling,
and strict JSON/model-ID validation. At least one model ID must be confirmed
before an account is persisted.

An upstream request may omit `Authorization` only when all of these properties
remain true:

- the account carries MultiVibe's explicit discovery metadata;
- its provider is `openai-compatible` and its location is `local`;
- its token is the empty string;
- its base URL and recorded endpoint use credential-free HTTP on literal
  `127.0.0.1` or `::1`, port `1234`;
- the final request origin matches the discovered endpoint;
- the path is one of LM Studio's supported `/v1` endpoints, with no query or
  fragment.

Redirects are not followed for classified local-runtime requests. A tokenless
remote, DNS, LAN, non-allowlisted port, or ambiguous URL is rejected before a
network request. Discovery performs no Cloud enrollment, community routing,
or outbound telemetry.
