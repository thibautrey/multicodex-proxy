# Local runtime discovery

MultiVibe can discover a supported model runtime on the same machine and add
it as an `openai-compatible` account without storing a fabricated API token.
The authenticated dashboard triggers it in the background after the session is
loaded. It can also trigger the operation directly through:

```http
POST /admin/local-runtimes/discover
```

The endpoint uses the existing admin authentication boundary. Replaying it is
idempotent: each runtime account keeps a deterministic ID such as
`local-runtime-lm-studio` or `local-runtime-omlx`, and a successful probe
updates that account instead of adding a duplicate.

## Supported discovery

The automatic probes use only documented default loopback endpoints. The
shared `8000` endpoint is classified from the response's official
`owned_by` value, so a running OMLX instance is never labelled MTPLX (or the
reverse).

| Runtime | Default probe | Runtime signature | Official icon |
| --- | --- | --- | --- |
| Ollama | `127.0.0.1`/`::1:11434/v1/models` | Port `11434` | [Ollama repository logo](https://github.com/ollama/ollama/blob/main/docs/ollama-logo.svg) |
| LM Studio | `127.0.0.1`/`::1:1234/v1/models` | Port `1234` | [LM Studio brand asset](https://lmstudio.ai/assets/marketing/brand/download/logos/lm-studio-icon-color.svg) |
| OMLX | `127.0.0.1`/`::1:8000/v1/models` | Every returned model has `owned_by: "omlx"` | [OMLX icon](https://omlx.ai/images/icon-rounded-dark.svg) |
| MTPLX | `127.0.0.1`/`::1:8000/v1/models` | Every returned model has `owned_by: "mtplx"` | [MTPLX app icon](https://github.com/youssofal/MTPLX/blob/main/apps/MTPLXApp/Resources/AppIcon.iconset/icon_256x256.png) |
| Exo | `127.0.0.1`/`::1:52415/models` | Every returned model has `owned_by: "exo"` | [Exo menu-bar icon](https://github.com/exo-explore/exo/blob/main/app/EXO/EXO/Assets.xcassets/menubar-icon.imageset/exo-logo-hq-square-transparent-bg.png) |

Official API references:

- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [LM Studio OpenAI compatibility](https://lmstudio.ai/docs/developer/openai-compat)
- [OMLX API](https://github.com/jundot/omlx)
- [MTPLX API](https://github.com/youssofal/MTPLX#the-server)
- [Exo API](https://github.com/exo-explore/exo/blob/main/docs/api.md)

The other adapter families remain available for explicit manual loopback
configuration. They do not have automatic candidates until a stable,
officially documented and non-ambiguous probe exists.

The bounded adapter registry also describes Ollama, llama.cpp/llama-server/llama-cpp-python,
vLLM, SGLang, LocalAI, Hugging Face TGI and Transformers Serve, Xinference,
MLX-LM, MLC LLM, Exo, Jan, GPT4All, KoboldCpp, text-generation-webui,
Aphrodite, TabbyAPI, llama-box, mistral.rs, NVIDIA NIM, TensorRT-LLM, Triton,
OpenLLM, BentoML, MTPLX and a manual OpenAI-compatible adapter. Each entry
declares its protocol, health and catalog contract, capabilities, authentication,
measurement units and bounded limits. Entries without a reliably identifiable
official probe remain manual and have no automatic candidates. MultiVibe does
not guess their ports or inspect processes, files, service registries, or the LAN.

Detection remains local until the user selects models. Cloud receives only the
selected model identifiers and the metadata allowlist shown before consent.

## Network and authentication boundary

Automatic probes are limited to the literal IPv4 and IPv6 loopback candidates
declared by the registry: the two Ollama URLs on port `11434`, the two LM
Studio URLs on port `1234`, the two OMLX and two MTPLX URLs on port `8000`, and
the two Exo URLs on port `52415`. No port scan is performed.

The probe has a deadline, a bounded response size, manual redirect handling,
and strict JSON/model-ID validation. At least one model ID must be confirmed
before an account is persisted.

An upstream request may omit `Authorization` only when all of these properties
remain true:

- the account carries MultiVibe's explicit discovery metadata;
- its provider is `openai-compatible` and its location is `local`;
- its token is the empty string;
- its base URL and recorded endpoint use credential-free HTTP on literal
  `127.0.0.1` or `::1`, on the adapter's declared port (`1234` for LM Studio,
  `11434` for Ollama, `8000` for OMLX/MTPLX, `52415` for Exo);
- the final request origin matches the discovered endpoint;
- the path is one of the adapter's supported endpoints, with no query or
  fragment (`/models` is reserved for Exo's model catalog; inference uses the
  supported `/v1` paths).

Redirects are not followed for classified local-runtime requests. A tokenless
remote, DNS, LAN, non-allowlisted port, or ambiguous URL is rejected before a
network request. Discovery performs no Cloud enrollment, community routing,
or outbound telemetry.
