<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/brand/vector/multivibe-logo-domain-dark-outlined.svg" />
    <source media="(prefers-color-scheme: light)" srcset="./assets/brand/vector/multivibe-logo-domain-light-outlined.svg" />
    <img alt="MultiVibe.cloud" src="./assets/brand/vector/multivibe-logo-domain-light-outlined.svg" width="560" />
  </picture>
</p>

<p align="center">
  <strong>OpenAI-compatible multi-provider router</strong><br/>
  <sub>Quota-aware routing • OAuth onboarding • Persistent storage • Request tracing • Automatic model discovery</sub>
</p>

<p align="center">
<a href="https://github.com/thibautrey/multivibe/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/thibautrey/multivibe?style=for-the-badge"/></a>
  <a href="https://github.com/thibautrey/multivibe/network/members"><img alt="GitHub forks" src="https://img.shields.io/github/forks/thibautrey/multivibe?style=for-the-badge"/></a>
  <a href="https://github.com/thibautrey/multivibe/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/thibautrey/multivibe?style=for-the-badge"/></a>
</p>

---

The complete logo kit, color palette, usage guidance, and export variants are available in [`assets/brand`](./assets/brand/README.md).

---

## ✨ What it does

MultiVibe acts as an OpenAI-compatible gateway that lets you route requests across multiple provider accounts while keeping a single API surface. The same proxy routes are exposed under `/v1` and at the root path for clients that expect either style.

- **OpenAI-compatible API**
  - `GET /v1/models`
  - `GET /v1/models/:id`
  - `POST /v1/chat/completions`
  - `POST /v1/responses`
  - `POST /v1/responses/compact`
  - `POST /v1/realtime/calls` (WebRTC SDP negotiation)
  - `GET /v1/realtime/voices` and `/v1/settings/voices` (ChatGPT voice eligibility/catalog)
  - root-path aliases: `/models`, `/chat/completions`, `/responses`, `/responses/compact`
  - compatibility endpoints: `/api/v1/models`, `/api/tags`, `/version`, `/props`, `/v1/props`
- **Streaming over SSE or WebSocket**
  - HTTP streaming uses plain `POST` with `stream: true`
  - HTTP response stream is `text/event-stream`
  - `/v1/responses` also accepts `ws://` / `wss://` and Codex-style JSON `response.create` frames
  - `/v1/chat/completions` and `/v1/responses/compact` remain HTTP-only
- **Realtime voice over WebRTC**
  - opaque multipart/SDP proxy compatible with Codex's native `realtime/calls` transport
  - audio flows directly over the negotiated WebRTC connection; MultiVibe is only on the session setup path
  - account-token refresh and quota-aware account rotation happen before the SDP answer is returned
- **Multi-account routing** with quota-aware failover across OpenAI, OpenAI-compatible, OpenCode Zen/Go, Mistral, z.ai, and Grok Build subscription accounts
- **Smart model aliases** with versioned conditions, local/cloud candidates, deterministic scoring, capacity constraints, budgets, and queue/reject fallbacks
- **Durable deferred jobs** with weighted priority/application fairness, SQLite leases, retries, polling/SSE results, and optional signed webhooks
- **Application-visible capacity** through authenticated snapshots and resumable SSE events
- **Image-aware routing override** that can route image-bearing requests to a chosen exposed model or alias while preserving the originally requested model in traces
- **OAuth onboarding** from dashboard with browser callback or device-code flow, including OpenCode Console and xAI device OAuth
- **OpenCode quota detection** for rolling 5-hour, weekly, and monthly OpenCode Go windows
- **Manual OpenAI-compatible connections** with custom `baseUrl` + API key
- **Optional local proxy API key** for HTTP and WebSocket clients via `PROXY_API_KEY`
- **Default OpenAI passthrough account** for root-path requests that are not handled by the OpenAI-compatible endpoints
- **Persistent account storage** across container restarts
- **Request tracing v2** (configurable recent-trace retention, server pagination, trace export, tokens/model/error/latency stats, optional full payload, and image payload diagnostics)
- **Usage stats endpoint** with global + per-account + per-route aggregates over full history
- **Time-range stats** (`sinceMs` / `untilMs`) while keeping lightweight history for long-term aggregates
- **zstd-compressed JSON request bodies** for compatible clients

---

## 🖼️ Dashboard gallery

> Screenshots below are taken in **sanitized mode** (`?sanitized=1`).

### Overview

![Overview](./assets/screen-overview.jpg)

### Accounts

![Accounts](./assets/screen-accounts.jpg)

### Tracing

![Tracing](./assets/screen-tracing.jpg)

### API docs tab

![Docs](./assets/screen-docs.jpg)

---

## 🧠 Routing strategy

When a request arrives, MultiVibe resolves the requested model to a provider and chooses an account with this strategy:

1. Share traffic according to the least-used known weekly quota; equal weekly usage alternates between accounts.
2. Stop selecting an account with a 5h window once that 5h quota reaches the near-limit threshold (`90%` by default), while another candidate remains available. This applies whether or not the other candidate is weekly-only.
3. Use the weekly reset time and configured priority as tie breakers.
4. On `429`/quota-like errors, temporarily block the account+model and retry on the next candidate.

When the requested model is an alias, MultiVibe resolves it to ordered target models and automatically falls back across target models/providers as quotas are hit.

Aliases are stored as schema v2 routing policies. Rules match application,
priority, reasoning effort, modalities, tools, input size, execution mode, and
time windows. The first matching rule filters candidates by location, wait,
context, and quality, then scores latency, cost, quality, and locality. Legacy
`targets` payloads remain accepted for one compatibility version and are
migrated automatically, including effort-qualified targets.

Capacity is measured per account/model from declared concurrency and throughput,
health/metrics endpoints, requests actually in flight, quota blocks, and learned
EWMA observations. RFC1918 and localhost OpenAI-compatible URLs migrate as
`local`; public providers migrate as `cloud`.

Aliases may also intentionally reuse an already exposed provider model name. In that case, the alias overrides the provider model and routes requests using the alias target order instead.

Alias targets can optionally be prefixed with a reasoning-effort tier: `minimal:`, `low:`, `medium:`, `high:`, or `xhigh:`. Requests using Chat Completions `reasoning_effort` or Responses `reasoning.effort` select the closest matching target tier before falling back.

If a request contains images and `imageRequestModelOverride` is set in admin settings, routing uses that model or alias when it is currently exposed. The upstream payload keeps image parts when translating between Chat Completions `image_url` content and Responses `input_image` content.

---

## 📦 Persistence

Everything important is file-based and survives restart (if `/data` is mounted):

- `/data/accounts.json`
- `/data/oauth-state.json`
- `/data/requests-trace.jsonl`
- `/data/requests-stats-history.jsonl`
- `/data/anonymous-usage-state.json` (mode `0600`, retry envelope only)
- `/data/provider-agent-selection.json` (mode `0600`, local explicit model selection only)
- `/data/provider-agent-runtime-endpoints.json` (mode `0600`, local loopback endpoints and optional runtime bearers)
- `/data/provider-agent-device-identity.json` (mode `0600`, local Ed25519 device identity and relay-shadow sequence)
- `/data/jobs.sqlite` (WAL, mode `0600`)

Recent trace retention defaults to the latest **1000** entries and can be changed with `TRACE_RETENTION_MAX`.
Stats history is append-only and keeps lightweight request metadata for long-term cost/volume tracking.
Deferred request payloads and results are stored in clear text in the protected
SQLite volume. Consumed or webhook-delivered results have a one-hour grace
period; unretrieved content is purged after 30 days.

> Docker compose already mounts `./data:/data`.

### Embedded provider-agent preview

Set `PROVIDER_AGENT_ENABLED=true` to let Core supervise the packaged provider
agent. `PROVIDER_AGENT_BINARY` selects its absolute binary path and
`PROVIDER_AGENT_STATE_PATH` selects the clean absolute local selection file;
by default the file is placed beside `STORE_PATH` as
`provider-agent-selection.json`. `PROVIDER_AGENT_RUNTIME_STATE_PATH` selects
the separate protected manual-runtime file and defaults to
`provider-agent-runtime-endpoints.json` beside `STORE_PATH`. The current admin
APIs can inventory the reviewed loopback candidates, configure one literal
loopback endpoint per manual adapter and persist an explicit model selection
locally. Runtime bearers are accepted only through the local authenticated
admin path, never returned by either API, and retained when an update omits the
secret field.

`PROVIDER_AGENT_DEVICE_KEY_PATH` selects the separate mode-`0600` Ed25519
device identity. The agent exposes only its public key and key ID in the local
manifest. Its authenticated relay-shadow endpoint signs Cloud-compatible
30-second session-open envelopes with a persisted monotonic sequence and fixed
non-commercial locks. This endpoint cannot carry customer content, open a
socket to a relay, enable routing or create compensation eligibility.
The local-account **Share models · Preview** experience exposes the same
inventory and revisioned selection without requiring a separate agent UI.
They do not enroll a node, send the inventory to Cloud, advertise capacity,
accept community workloads, or enable earnings and payouts.

### Anonymous model-demand sharing

Anonymous sharing is enabled by default for new and upgraded installations and can be changed immediately in the **Tracing** tab. The activation timestamp is materialized during upgrade, so historical usage from before activation is never backfilled. Re-enabling creates a new activation timestamp.

For each completed UTC day, Core first downloads the public hosted-inference allowlist. It then reads the lightweight local trace history and prepares at most 50 contributions containing only an exact allowlisted canonical model ID and output-token volume rounded down to thousands, capped at one billion tokens per model. The envelope also contains the UTC-day window and a random event UUID used only to retry that day safely.

Core never shares prompts, responses, input-token volumes, projects, accounts, emails, hardware, hostnames, request headers, fine-grained timestamps, or a stable installation ID. If the allowlist or Cloud API is unavailable, the cycle fails closed and inference continues normally. Unchecking the control aborts future sends and deletes any unsent envelope immediately.

---

## 🚀 Quick start (Docker)

```bash
./scripts/deploy.sh
```

The script calculates the commit identity, rebuilds and recreates the
container, then verifies that `/health` reports the same image identity.
It also stores the identities in the local, ignored `.env` file so subsequent
commands such as `docker compose logs` work without extra environment setup.
Set `HEALTH_URL` when deploying against a remote host:

```bash
HEALTH_URL=http://192.0.2.149:1455/health ./scripts/deploy.sh
```

- Dashboard: `http://localhost:1455`
- Health: `http://localhost:1455/health`

The health response includes the exact image identity in `gitSha` and
`buildId`. Verify it after deployment:

```bash
curl -fsS http://localhost:1455/health
```

---

## 🔐 OAuth onboarding flow

Because this is often deployed remotely (private environment/VPS), OpenAI onboarding supports both browser callback and device-code flows. The browser callback flow uses a manual redirect paste step:

1. Open dashboard
2. For OpenAI accounts, enter the account email
3. Choose **Browser callback** and click **Start OAuth**
4. Complete login in browser
5. Copy the full redirect URL shown after the callback completes
6. Paste that URL in the dashboard and click **Complete OAuth**

For headless or remote setups, choose **Device code** instead. The dashboard opens
the verification page, shows a one-time code, and completes automatically after
you approve the login.

For OpenCode, choose **OpenCode Zen / Go**. You can enter an `OPENCODE_API_KEY`
from the OpenCode Console or click **Connect OpenCode account** to use the
official `opencode-cli` device flow. OAuth accounts discover their Zen/Go API
root from the Console. The Accounts table refreshes and displays the rolling
5-hour, weekly, and monthly quotas exposed by OpenCode Go. Zen and other plans
that do not expose the Go usage endpoint remain routable and display `N/A`
instead of reporting a quota-probe error.

For Grok Build, choose **Grok Build (subscription)** and start the device login.
The proxy sends the resulting subscription bearer to
`https://cli-chat-proxy.grok.com/v1`, together with the same client headers as
the official Grok Build CLI. It does not use `XAI_API_KEY` and therefore does
not switch the account to pay-per-token API billing.

An existing official CLI session can instead be imported with **Import
configured auth.json**. The server reads `XAI_AUTH_PATH` (default
`~/.grok/auth.json`) and ignores `xai::api_key` entries. In Docker, mount the
file read-only and point `XAI_AUTH_PATH` at the container path. Deprecated
pre-OIDC `web_login` entries are also rejected because the current Grok CLI no
longer treats them as a reliable sampling credential:

```yaml
services:
  multivibe:
    environment:
      - XAI_AUTH_PATH=/run/secrets/grok-auth.json
    volumes:
      - ${HOME}/.grok/auth.json:/run/secrets/grok-auth.json:ro
```

Device OAuth is preferred when the CLI and proxy may run concurrently. Refresh
tokens rotate; importing the same session into independent stores can make one
consumer stale after the other refreshes it.

Mistral, z.ai, OpenCode service accounts, and generic OpenAI-compatible accounts use manual token/API-key
entry in the dashboard. Generic OpenAI-compatible accounts also require a
`baseUrl`.

Default expected redirect URI:

```text
http://localhost:1455/auth/callback
```

---

## 🧪 API examples

### List models

```bash
curl http://localhost:1455/v1/models
```

When `PROXY_API_KEY` is set, send it as either a Bearer token or `x-api-key`.
To identify traffic from several applications without changing authentication or
quota behavior, set `PROXY_API_KEYS` to a JSON object whose names identify the
applications and whose values are their keys. For example:

```env
PROXY_API_KEYS={"mobile-app":"key-for-mobile","back-office":"key-for-back-office"}
```

Each accepted request stores the matching application name in its trace. Usage
is available per application from `/admin/stats/usage` in `byApplication`, and
can be filtered with `?application=mobile-app`. `PROXY_API_KEY` remains supported
and is attributed to the application name `default`. All keys share the same
account pool, routing, quota state, and failover behavior.
An authenticated dashboard session can still use the API. Configure
`ADMIN_TOKEN` as well when using the dashboard so it can establish that
session:

```bash
curl -H "Authorization: Bearer $PROXY_API_KEY" \
  http://localhost:1455/v1/models
```

Example model object returned:

```json
{
  "id": "gpt-5.3-codex",
  "object": "model",
  "created": 1730000000,
  "owned_by": "multivibe",
  "metadata": {
    "context_window": null,
    "max_output_tokens": null,
    "supports_reasoning": true,
    "supports_tools": true,
    "supported_tool_types": ["function"]
  }
}
```

### Chat completion

```bash
curl -X POST http://localhost:1455/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-5.3-codex",
    "messages": [{"role":"user","content":"hello"}]
  }'
```

### Streaming responses

```bash
curl -N -X POST http://localhost:1455/v1/responses \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-5.3-codex",
    "input": "hello",
    "stream": true
  }'
```

### Smart admission and deferred jobs

Inference endpoints accept these optional headers:

```text
X-MultiVibe-Priority: critical|interactive|standard|batch
X-MultiVibe-Execution: sync|auto|defer
X-MultiVibe-Max-Wait-Ms: 30000
X-MultiVibe-Deadline: 2026-08-27T07:00:00+02:00
X-MultiVibe-Idempotency-Key: translation-order-42
X-MultiVibe-Webhook: <registered webhook id>
```

Without them, requests retain the historical synchronous behavior unless the
selected alias explicitly declares defaults. Non-streamed deferred requests
return `202` and a `multivibe.job`. Streaming, WebSocket, and Realtime requests
cannot be deferred.

```bash
curl -X POST http://localhost:1455/v1/responses \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "content-type: application/json" \
  -H "X-MultiVibe-Priority: batch" \
  -H "X-MultiVibe-Execution: defer" \
  -H "X-MultiVibe-Idempotency-Key: nightly-translation-42" \
  -d '{"model":"smart-translation","input":"..."}'
```

Application-isolated job endpoints are:

- `GET /v1/jobs` and `GET /v1/jobs/:id`
- `GET /v1/jobs/:id/result`
- `GET /v1/jobs/:id/events` (SSE with `Last-Event-ID`)
- `DELETE /v1/jobs/:id`

Capacity is available through `GET /v1/capacity?model=<alias>&priority=<class>`
and resumable events through `GET /v1/capacity/events`. Both require the same
application authentication as inference. The admission decision remains
authoritative over a previously returned snapshot.

`JOBS_DB_PATH` defaults to `/data/jobs.sqlite`.
`JOB_WORKER_CONCURRENCY` defaults to 16; account/model capacity profiles remain
the authoritative per-destination concurrency limit.

For application-side adoption, including idempotency, polling/SSE, result
consumption, cancellation, webhooks, retention, and restart recovery, see the
[deferred batch integration guide](docs/batch-jobs.md). A standalone
[coding-agent prompt](docs/prompts/implement-multivibe-batch.md) is also
available for adapting an existing project.

### WebSocket responses

```js
const ws = new WebSocket("ws://localhost:1455/v1/responses", {
  headers: {
    Authorization: "Bearer YOUR_TOKEN",
  },
});

ws.onmessage = (event) => {
  console.log(JSON.parse(event.data));
};

ws.onopen = () => {
  ws.send(
    JSON.stringify({
      type: "response.create",
      model: "gpt-5.3-codex",
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
      ],
      stream: true,
    }),
  );
};
```

### Realtime voice (WebRTC)

MultiVibe proxies the unified Realtime WebRTC handshake rather than rebuilding
voice as separate speech-to-text, Responses, and text-to-speech requests. This
keeps latency low, preserves interruption/VAD and data-channel events, and keeps
audio off the proxy after session setup.

The default mode uses OpenAI ChatGPT/Codex OAuth accounts already configured in
MultiVibe and forwards to ChatGPT's native Codex Realtime endpoint:

```env
REALTIME_PROVIDER=openai
```

Point compatible Codex clients at the proxy's API base:

```toml
experimental_realtime_webrtc_call_base_url = "https://multivibe.example/v1"
```

The client sends the native multipart form (`sdp` plus `session`) to
`POST /v1/realtime/calls`. The response is the upstream SDP answer. The same
route is also exposed without the `/v1` prefix.

To use a standard OpenAI API key instead of a ChatGPT subscription, configure
an `openai-compatible` account whose `baseUrl` is `https://api.openai.com/v1`,
then set:

```env
REALTIME_PROVIDER=openai-compatible
```

This is intentionally opt-in because Realtime API-key traffic is billed on the
API platform and must never be selected silently as a fallback from a ChatGPT
subscription. A custom full upstream URL can be supplied when needed:

```env
REALTIME_WEBRTC_CALL_URL=https://api.openai.com/v1/realtime/calls
REALTIME_REQUEST_TIMEOUT_MS=30000
```

Voice eligibility and the selected ChatGPT voice can be checked through:

```bash
curl -H "Authorization: Bearer $PROXY_API_KEY" \
  "https://multivibe.example/v1/realtime/voices?spoken_language=fr-FR&voice_mode=advanced"
```

An upstream response without `selected`, or a rejected upstream request, means
the selected ChatGPT account/workspace is not currently voice-enabled. This is
the same server-side signal Codex Desktop uses for its unavailable state.

### Create a smart alias policy

```bash
curl -X POST http://localhost:1455/admin/model-aliases \
  -H "x-admin-token: change-me" \
  -H "content-type: application/json" \
  -d '{
    "schemaVersion": 2,
    "id": "smart-code",
    "enabled": true,
    "description": "Prefer the future local Mac, overflow to cloud",
    "rules": [{
      "id": "interactive",
      "match": {"priorities": ["critical", "interactive"]},
      "constraints": {"allowedLocations": ["local", "cloud"]},
      "objectives": {"latency": 50, "cost": 10, "quality": 25, "locality": 15},
      "candidates": [
        {"model": "local-model", "location": "local", "quality": 80},
        {"model": "gpt-5.6", "location": "cloud", "quality": 95}
      ],
      "onNoCapacity": "queue"
    }]
  }'
```

The legacy payload remains accepted during the compatibility window and is
migrated immediately to schema v2:

```json
{
  "id": "reasoning-coder",
  "targets": ["low:gpt-5.3-codex", "high:gpt-5.3-pro"],
  "enabled": true
}
```

### Update routing settings

```bash
curl -X PATCH http://localhost:1455/admin/settings \
  -H "x-admin-token: change-me" \
  -H "content-type: application/json" \
  -d '{
    "defaultPassthroughAccountId": "openai-account-id",
    "imageRequestModelOverride": "vision-model-or-alias"
  }'
```

Use an empty string for either field to clear it.

### Read traces

```bash
# Paginated API (recommended)
curl -H "x-admin-token: change-me" \
  "http://localhost:1455/admin/traces?page=1&pageSize=100"
```

```bash
# Legacy compatibility mode
curl -H "x-admin-token: change-me" \
  "http://localhost:1455/admin/traces?limit=50"
```

To inspect which headers a client sends, temporarily start the proxy with
`TRACE_INCLUDE_HEADERS=true`. The trace detail and the `Full Trace Object` then
include `requestHeaders`. Header names are preserved, while credentials,
cookies, tokens, session values, and similar secrets are replaced with
`[REDACTED]`. Header tracing is disabled by default and is not written to the
long-term stats history.

### Attribute Codex usage by repository

MultiVibe can correlate Codex Desktop sessions with Git repositories without
patching Codex. A user-level official `SessionStart` hook sends the Codex
`session_id`, working directory, sanitized Git remote, and worktree metadata to
MultiVibe. Incoming traces carry the same id in `thread-id`, so project
attribution is stored directly in recent traces and long-term usage history.

Codex can also send the deterministic project root on every provider request,
including internal/system requests that do not have a session registered by the
hook. Configure the custom provider to map an environment variable to the
following header:

```toml
[model_providers.multivibe]
env_http_headers = { "X-MultiVibe-Project-Root" = "MULTIVIBE_PROJECT_ROOT", "X-MultiVibe-Project-Host" = "MULTIVIBE_PROJECT_HOST" }
```

Set that variable before starting Codex from a checkout (the fallback to the
current directory also supports non-Git workspaces):

```bash
export MULTIVIBE_PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"
export MULTIVIBE_PROJECT_HOST="$(hostname)"
/Applications/ChatGPT.app/Contents/Resources/codex --profile multivibe
```

MultiVibe always tries the exact `session_id` registry lookup first. The root
and stable execution-host headers are used together only when that lookup
misses, and only when they identify one registered project; missing context or
an ambiguous match is left unattributed rather than guessed.

Requests routed through LiteLLM can identify their project with the
`X-LiteLLM-Key-Alias` header. When present, this alias takes precedence over
Codex session attribution and is used as the project name with a stable project
identifier.

Set a dedicated registration token on the server when possible:

```bash
CODEX_PROJECT_REGISTRATION_TOKEN=replace-with-a-random-token
```

When this variable is unset, `ADMIN_TOKEN` is accepted for compatibility. If
both are empty, project registration is disabled.

The simplest installation path is in the dashboard: open **Tracing**, click
**Install hook** next to **Codex session attribution**, then paste and execute
the copied command in a terminal on the machine that runs Codex. The same
command works on macOS and Linux.

Install the hook once on every machine or remote execution host that runs Codex:

```bash
read -s MULTIVIBE_PROJECT_TOKEN
export MULTIVIBE_PROJECT_TOKEN
node scripts/install-codex-project-hook.mjs --url http://192.0.2.149:1455
unset MULTIVIBE_PROJECT_TOKEN
```

For the local macOS Codex app, run the same command in a terminal on the Mac,
from a local checkout of this repository. The installer writes to the Codex
home of the host where it runs (`~/.codex` by default); running it in a remote
Codex shell only installs the remote hook.

Codex does not run a newly installed or changed user hook until its exact
definition has been reviewed and trusted. On the same local or remote execution
host, open Codex, run `/hooks`, select `SessionStart`, review the MultiVibe
command, and press `t` to trust it. Then start or resume a session. The hook
overview must show the `SessionStart` hook as active rather than awaiting
review.

The installer preserves existing `~/.codex/hooks.json` entries, stores the
secret in `~/.codex/multivibe-project.json` with mode `0600`, and installs a
synchronous, fail-open hook. New, resumed, cleared, and compacted sessions are
registered. See the [official Codex hooks documentation](https://developers.openai.com/codex/hooks/).

Project endpoints:

- `POST /admin/codex-sessions` with `x-codex-project-token`
- `GET /admin/codex-sessions` with `x-admin-token`
- `GET /admin/codex-projects` with `x-admin-token`

### Usage stats

```bash
curl -H "x-admin-token: change-me" \
  "http://localhost:1455/admin/stats/usage?sinceMs=1735689600000&untilMs=1738291200000"
```

### Trace stats (historical)

```bash
curl -H "x-admin-token: change-me" \
  "http://localhost:1455/admin/stats/traces?sinceMs=1735689600000&untilMs=1738291200000"
```

### Export traces

```bash
curl -H "x-admin-token: change-me" \
  "http://localhost:1455/admin/traces/export.zip?sinceMs=1735689600000&untilMs=1738291200000" \
  -o traces-export.zip
```

Optional filters:

- `accountId=<id>`
- `route=/v1/chat/completions`
- `projectId=<project-id>`
- `sinceMs=<epoch_ms>`
- `untilMs=<epoch_ms>`

Model alias admin endpoints:

- `GET /admin/model-aliases`
- `POST /admin/model-aliases`
- `PATCH /admin/model-aliases/:id`
- `DELETE /admin/model-aliases/:id`

Proxy API key admin endpoints:

- `GET /admin/proxy-api-keys` (secrets are masked)
- `POST /admin/proxy-api-keys` with `{"application":"staging-worker"}`
- `DELETE /admin/proxy-api-keys/:id`

Keys created from the dashboard are persisted in `STORE_PATH`, take effect
immediately, and are returned in full only by the creation response. Keys from
`PROXY_API_KEY` and `PROXY_API_KEYS` remain read-only in the dashboard.

Settings endpoints:

- `GET /admin/settings`
- `PATCH /admin/settings`

Embedded provider-agent endpoints:

- `GET /admin/provider-agent/adapters`
- `GET /admin/provider-agent/manifest`
- `GET/PUT /admin/provider-agent/runtime-endpoints`
- `GET /admin/provider-agent/detected-models`
- `GET/PUT /admin/provider-agent/selection`
- `POST /admin/provider-agent/relay-shadow/session-open`

OAuth admin endpoints:

- `POST /admin/oauth/start`
- `GET /admin/oauth/status/:flowId`
- `POST /admin/oauth/complete`
- `POST /admin/oauth/device/poll`
- `POST /admin/grok/import`

To start Grok Build device OAuth, call `POST /admin/oauth/start` with
`{"provider":"xai","method":"device"}`. Poll the returned `flowId` through the
same `/admin/oauth/device/poll` endpoint used by OpenAI device OAuth.

OpenCode Console uses the same endpoints with
`{"provider":"opencode","method":"device"}`. The returned access and refresh
tokens are stored with the account; OpenCode API keys can instead be added
directly through `POST /admin/accounts` with `provider: "opencode"`.

---

## ⚙️ Environment variables

| Variable                          | Default                                   | Description                                                         |
| --------------------------------- | ----------------------------------------- | ------------------------------------------------------------------- |
| `PORT`                            | `1455`                                    | HTTP server port                                                    |
| `STORE_PATH`                      | `/data/accounts.json`                     | Accounts, aliases, API keys, and settings store                     |
| `PROVIDER_AGENT_STATE_PATH`       | beside `STORE_PATH`                       | Mode-0600 local explicit provider model selection                   |
| `PROVIDER_AGENT_RUNTIME_STATE_PATH` | beside `STORE_PATH`                     | Mode-0600 manual loopback endpoints and optional runtime bearers    |
| `PROVIDER_AGENT_DEVICE_KEY_PATH`   | beside `STORE_PATH`                       | Mode-0600 Ed25519 device identity and relay-shadow sequence         |
| `OAUTH_STATE_PATH`                | `/data/oauth-state.json`                  | OAuth flow state                                                    |
| `TRACE_FILE_PATH`                 | `/data/requests-trace.jsonl`              | Recent request trace file                                           |
| `TRACE_STATS_HISTORY_PATH`        | `/data/requests-stats-history.jsonl`      | Lightweight request history for long-term stats                     |
| `ANONYMOUS_USAGE_STATE_PATH`      | `/data/anonymous-usage-state.json`        | Mode-0600 daily retry envelope with no stable installation ID       |
| `ANONYMOUS_USAGE_API_BASE_URL`    | `https://api.multivibe.cloud`             | Public allowlist and anonymous daily aggregate API                  |
| `CODEX_PROJECTS_PATH`             | `/data/codex-projects.json`               | Persistent Codex session-to-project registry                        |
| `TRACE_RETENTION_MAX`             | `1000`                                    | Number of recent full traces to retain; minimum effective value is 100 |
| `TRACE_INCLUDE_BODY`              | `false`                                   | Persist full request payloads when explicitly enabled; trace stats still work when disabled |
| `TRACE_INCLUDE_HEADERS`           | `false`                                   | Persist sanitized inbound request headers in recent traces; credentials and tokens are redacted, and headers are excluded from long-term stats history |
| `USAGE_STALE_WHILE_REVALIDATE`    | `true`                                    | Serve stale usage, or route with a missing snapshot, while refreshing in the background |
| `USAGE_STALE_MAX_AGE_MS`          | `1800000`                                 | Maximum snapshot age eligible for stale-while-revalidate; older snapshots block for refresh |
| `REQUEST_BODY_LIMIT`              | `100mb`                                   | Max accepted JSON or decompressed zstd request body size            |
| `PROXY_MODELS`                    | `gpt-5.3-codex,gpt-5.2-codex,gpt-5-codex` | Fallback comma-separated model list for `/v1/models`                |
| `MODELS_CLIENT_VERSION`           | `0.144.1`                                 | Codex version sent to OpenAI model discovery and runtime requests     |
| `MODELS_CACHE_MS`                 | `600000`                                  | Model discovery cache duration (ms)                                 |
| `MODELS_STALE_WHILE_REVALIDATE`   | `true`                                    | Serve a bounded stale model catalog while refreshing it in the background |
| `MODELS_STALE_MAX_AGE_MS`         | `1800000`                                 | Maximum model-catalog age eligible for stale-while-revalidate       |
| `ADMIN_TOKEN`                     | empty                                     | Admin endpoints auth token; empty disables the admin-token check    |
| `CODEX_PROJECT_REGISTRATION_TOKEN` | `ADMIN_TOKEN`                            | Limited token accepted by the Codex session registration endpoint   |
| `PROXY_API_KEY`                   | empty                                     | Optional Bearer or `x-api-key` required by HTTP and WebSocket proxy endpoints |
| `PROXY_API_KEYS`                  | empty                                     | JSON object of application names to proxy keys; attribution only, with shared auth behavior and quotas |
| `CLAUDE_CODE_MODEL`               | `gpt-5.6-luna`                            | Upstream model used for Claude Code opus/sonnet aliases             |
| `CLAUDE_CODE_FAST_MODEL`          | `gpt-5.4-mini`                            | Upstream model used for Claude Code haiku/fast aliases              |
| `CHATGPT_BASE_URL`                | `https://chatgpt.com`                     | OpenAI/ChatGPT upstream base URL                                    |
| `REALTIME_PROVIDER`               | `openai`                                  | Realtime account provider (`openai` or `openai-compatible`)         |
| `REALTIME_WEBRTC_CALL_URL`        | empty                                     | Optional full Realtime WebRTC upstream URL                          |
| `REALTIME_REQUEST_TIMEOUT_MS`     | `30000`                                   | Realtime SDP request timeout (ms)                                   |
| `UPSTREAM_PATH`                   | `/backend-api/codex/responses`            | OpenAI upstream request path                                        |
| `UPSTREAM_COMPACT_PATH`           | `/backend-api/codex/responses/compact`    | OpenAI upstream path for `/v1/responses/compact`                    |
| `MISTRAL_BASE_URL`                | `https://api.mistral.ai`                  | Mistral upstream base URL                                           |
| `MISTRAL_UPSTREAM_PATH`           | `/v1/responses`                           | Mistral upstream path for responses                                 |
| `MISTRAL_COMPACT_UPSTREAM_PATH`   | `/v1/responses/compact`                   | Mistral upstream path for compact responses                         |
| `OPENCODE_BASE_URL`               | `https://opencode.ai/zen`                 | OpenCode API root before `/v1`; OAuth discovery can override it per account |
| `OPENCODE_CONSOLE_URL`            | `https://opencode.ai/console`             | OpenCode Console API and device OAuth base URL                       |
| `OPENCODE_OAUTH_CLIENT_ID`        | `opencode-cli`                            | Official OpenCode device OAuth client id                             |
| `ZAI_BASE_URL`                    | `https://api.z.ai`                        | z.ai upstream base URL                                              |
| `ZAI_UPSTREAM_PATH`               | `/api/coding/paas/v4/chat/completions`    | z.ai Coding Plan upstream path for responses routed through chat completions |
| `ZAI_COMPACT_UPSTREAM_PATH`       | `/api/coding/paas/v4/chat/completions`    | z.ai Coding Plan upstream path for compact responses                |
| `ZAI_MODELS_PATH`                 | `/api/paas/v4/models`                     | z.ai model-discovery path                                           |
| `XAI_BASE_URL`                    | `https://cli-chat-proxy.grok.com/v1`      | Grok Build subscription upstream base URL                           |
| `XAI_RESPONSES_PATH`              | `/responses`                              | Grok Build Responses upstream path                                  |
| `XAI_CHAT_COMPLETIONS_PATH`       | `/chat/completions`                       | Grok Build Chat Completions upstream path                           |
| `XAI_MODELS_PATH`                 | `/models`                                 | Grok Build model-discovery path                                     |
| `XAI_AUTH_PATH`                   | `~/.grok/auth.json`                       | Official Grok CLI credential file read by the import action         |
| `XAI_OAUTH_ISSUER`                | `https://auth.x.ai`                       | Trusted xAI OAuth issuer                                            |
| `XAI_OAUTH_CLIENT_ID`             | official Grok Build client id             | OAuth client used for device login and refresh                      |
| `XAI_OAUTH_SCOPES`                | official Grok Build scope set             | Comma- or space-separated xAI OAuth scopes                          |
| `XAI_CLIENT_VERSION`              | `0.2.114`                                 | Grok CLI version header sent to subscription endpoints              |
| `XAI_CLIENT_IDENTIFIER`           | `grok-pager`                              | Grok CLI client identifier header                                   |
| `XAI_TOKEN_AUTH`                  | `xai-grok-cli`                            | xAI subscription token-auth selector                                |
| `XAI_USER_AGENT`                  | generated Grok CLI user agent             | User-Agent sent to Grok Build endpoints                             |
| `OAUTH_CLIENT_ID`                 | `app_EMoamEEZ73f0CkXaXp7hrann`            | OpenAI OAuth client id                                              |
| `OAUTH_AUTHORIZATION_URL`         | `https://auth.openai.com/oauth/authorize` | OAuth authorize endpoint                                            |
| `OAUTH_TOKEN_URL`                 | `https://auth.openai.com/oauth/token`     | OAuth token endpoint                                                |
| `OAUTH_DEVICE_AUTHORIZATION_URL`  | `https://auth.openai.com/api/accounts/deviceauth/usercode` | OAuth device-code start endpoint                 |
| `OAUTH_DEVICE_TOKEN_URL`          | `https://auth.openai.com/api/accounts/deviceauth/token` | OAuth device-code polling endpoint                      |
| `OAUTH_DEVICE_VERIFICATION_URL`   | `https://auth.openai.com/codex/device`    | OAuth device-code verification page                                 |
| `OAUTH_DEVICE_REDIRECT_URI`       | `https://auth.openai.com/deviceauth/callback` | OAuth device-code token exchange redirect URI                   |
| `OAUTH_SCOPE`                     | `openid profile email offline_access`     | OAuth scope                                                         |
| `OAUTH_AUDIENCE`                  | empty                                     | Optional OAuth audience                                             |
| `OAUTH_REDIRECT_URI`              | `http://localhost:1455/auth/callback`     | Redirect URI                                                        |
| `TOKEN_REFRESH_MARGIN_MS`         | `60000`                                   | Refresh OAuth tokens this long before expiry                        |
| `ACCOUNT_FLUSH_INTERVAL_MS`       | `5000`                                    | Debounce interval for writing modified account state to disk        |
| `FIVE_HOUR_QUOTA_THRESHOLD_PERCENT`| `90`                                      | 5h usage percentage at which a weekly-only account is preferred exclusively |
| `CODEX_SESSION_AFFINITY`             | `false`                                     | Keep each Codex session sticky to an eligible account per application and provider (in-memory, 1h TTL) |
| `CODEX_SESSION_AFFINITY_MAX_ENTRIES` | `10000`                                     | Maximum number of in-memory session-affinity entries per proxy process |
| `MAX_ACCOUNT_RETRY_ATTEMPTS`      | `10`                                      | Max accounts to try on quota/rate-limit errors                      |
| `MAX_UPSTREAM_RETRIES`            | `5`                                       | Retries per upstream request for transient 5xx/transport errors; quota rotates accounts |
| `UPSTREAM_BASE_DELAY_MS`          | `2000`                                    | Base backoff delay for upstream retries (ms)                        |
| `HANG_RETRY_INTERVAL_MS`          | `10000`                                   | Delay between retry cycles when all accounts are exhausted (ms)     |
| `HANG_RETRY_MAX_DURATION_MS`      | `120000`                                  | Max total time to hang-and-retry before returning 429 to client (ms) |
| `RATE_LIMIT_BLOCK_MS`             | `60000`                                   | Duration to block an account+model after a 429 response (ms)        |
| `EXCLUDED_PROVIDER_MODELS`        | empty                                     | Comma-separated `provider:model` list to prevent routing a model to specific providers |
| `EMPTY_RESPONSE_BLOCK_THRESHOLD`  | `3`                                       | Empty assistant outputs before temporarily blocking account+model   |
| `EMPTY_RESPONSE_BLOCK_DURATION_MS`| `30000`                                   | Duration of an empty-response account+model block (ms)              |
| `EMPTY_RESPONSE_WINDOW_MS`        | `300000`                                  | Time window for counting empty assistant outputs (ms)               |
| `SENTRY_DSN`                      | empty                                     | Optional Sentry DSN; unset disables Sentry                          |
| `SENTRY_ENVIRONMENT`              | `NODE_ENV` or `production`                | Sentry environment                                                  |
| `SENTRY_TRACES_SAMPLE_RATE`       | `0.1`                                     | Sentry performance sampling rate                                    |

---

Grok Build subscription access is intended for the account owner or another
trusted operator. Do not expose a subscription-backed instance as a public
multi-tenant service, and review the current xAI terms before deployment.

---

## 🛠️ Local dev

```bash
npm install
npm --prefix web install
npm run dev
```

For a production-style local run:

```bash
npm run build
npm run start
```

---

## Star History

<a href="https://www.star-history.com/?type=date&repos=thibautrey%2Fmultivibe">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=thibautrey/multivibe&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=thibautrey/multivibe&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=thibautrey/multivibe&type=date&legend=top-left" />
 </picture>
</a>
---

## 🤝 Contributing

PRs and issues are welcome.

If you open a PR:

- keep it focused
- include before/after behavior
- include screenshots for UI changes
