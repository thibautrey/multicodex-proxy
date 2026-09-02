<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/brand/vector/multivibe-logo-domain-dark-outlined.svg" />
    <source media="(prefers-color-scheme: light)" srcset="./assets/brand/vector/multivibe-logo-domain-light-outlined.svg" />
    <img alt="MultiVibe.cloud" src="./assets/brand/vector/multivibe-logo-domain-light-outlined.svg" width="560" />
  </picture>
</p>

<p align="center">
  <strong>One OpenAI-compatible endpoint. Multiple providers, accounts, quotas, and routing policies.</strong>
</p>

<p align="center">
  <a href="https://github.com/thibautrey/multicodex-proxy/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/thibautrey/multicodex-proxy?style=for-the-badge" /></a>
  <a href="https://github.com/thibautrey/multicodex-proxy/network/members"><img alt="GitHub forks" src="https://img.shields.io/github/forks/thibautrey/multicodex-proxy?style=for-the-badge" /></a>
  <a href="https://github.com/thibautrey/multicodex-proxy/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/thibautrey/multicodex-proxy?style=for-the-badge" /></a>
</p>

MultiVibe is a self-hosted TypeScript gateway for routing OpenAI, Anthropic,
Codex, and OpenAI-compatible client traffic across several provider accounts.
It combines quota-aware failover, policy-based model aliases, deferred jobs,
Realtime/WebSocket support, and an administration dashboard behind one stable
API surface.

[Quick start](#-quick-start) ·
[Dashboard](#-dashboard) ·
[Providers](#-providers-and-onboarding) ·
[API](#-api-surface) ·
[Routing](#-routing-strategy) ·
[Configuration](#-configuration) ·
[Development](#-local-development) ·
[Brand kit](./assets/brand/README.md)

---

## ✨ At a glance

| Area | What MultiVibe provides |
| --- | --- |
| Client APIs | Responses, Chat Completions, Anthropic Messages, models, Realtime WebRTC, SSE, and Responses over WebSocket |
| Providers | OpenAI/ChatGPT, generic OpenAI-compatible APIs, OpenCode Zen/Go, Mistral, z.ai Coding Plan, and Grok Build subscriptions |
| Account routing | Automatic model discovery, quota headroom selection, account/model blocks, retries, and optional Codex session affinity |
| Smart aliases | Conditional schema-v2 policies, local/cloud candidates, capacity constraints, scoring, budgets, simulation, and queue/reject fallbacks |
| Deferred work | Durable SQLite jobs, priority and application fairness, idempotency, polling/SSE results, cancellation, and signed webhooks |
| Operations | Admin dashboard, dynamic application API keys, traces, cost/token/latency statistics, project attribution, exports, and Sentry integration |

MultiVibe exposes the same inference routes under `/v1` and at the root for
clients that expect either style. Compatibility endpoints for Ollama- and
LiteLLM-style discovery are also available.

---

## 🚀 Quick start

### Requirements

- Docker with Compose v2
- Git, curl, and Node.js 22+ on the deployment host
- At least one supported provider account or API key

### 1. Clone and secure the deployment

~~~bash
git clone https://github.com/thibautrey/multicodex-proxy.git
cd multicodex-proxy
~~~

> [!WARNING]
> MultiVibe controls upstream accounts that may carry paid quotas. The shipped
> Compose file uses `ADMIN_TOKEN=change-me` as a local placeholder, and the
> inference API is unrestricted when no proxy API key exists. Replace the admin
> token, configure `PROXY_API_KEY` (or create application keys immediately),
> and keep port 1455 behind a private network or authenticated TLS proxy before
> exposing it outside a trusted host.

Store both initial secrets in the ignored `.env` file:

~~~dotenv
ADMIN_TOKEN=<long-random-admin-secret>
PROXY_API_KEY=<long-random-proxy-secret>
~~~

The existing proxy-key entry already reads `.env`. Replace the literal admin
entry in `docker-compose.yml` with required interpolation so Compose cannot
start without the secret:

~~~yaml
- ADMIN_TOKEN=${ADMIN_TOKEN:?ADMIN_TOKEN must be set in .env}
~~~

Do not commit either value. For a managed deployment, use its secret-injection
mechanism instead of `.env`.

### 2. Build and deploy

~~~bash
./scripts/deploy.sh
~~~

The deployment script records the current commit identity in `.env`, rebuilds
and recreates the container, then waits for `/health` to report the same
`gitSha` and `buildId`. Use `HEALTH_URL` for a remote deployment:

~~~bash
HEALTH_URL=https://multivibe.example/health ./scripts/deploy.sh
~~~

After startup:

- Dashboard: [http://localhost:1455](http://localhost:1455)
- Health: [http://localhost:1455/health](http://localhost:1455/health)

~~~bash
curl -fsS http://localhost:1455/health
~~~

`/health` is a liveness and build-identity check only; it does not validate
storage or provider access. The authenticated `/v1/models` request in step 4 is
the first end-to-end smoke test.

### 3. Add a provider

Open **Accounts** in the dashboard and add at least one account. OAuth and
manual-key options differ by provider; see
[Providers and onboarding](#-providers-and-onboarding).

### 4. Call the API

~~~bash
export MULTIVIBE_API_KEY="replace-with-your-proxy-key"

curl -H "Authorization: Bearer $MULTIVIBE_API_KEY" \
  http://localhost:1455/v1/models
~~~

Point an OpenAI-compatible client at `http://localhost:1455/v1` and use the
same key. The requested model can be a discovered provider model or an enabled
MultiVibe alias.

### Routine operations

~~~bash
# Container state and recent logs
docker compose ps
docker compose logs -f --tail=200 multivibe

# Clean stop and start
docker compose stop multivibe
docker compose start multivibe

# Update to the latest fast-forward commit and rebuild
git pull --ff-only
./scripts/deploy.sh
~~~

`docker compose restart` only restarts the existing image; it does not rebuild
new code. To roll back from a clean deployment checkout, switch to a known-good
commit, run `./scripts/deploy.sh`, and switch back to your normal branch before
the next update.

---

## 🖥️ Dashboard

The React dashboard is served by the proxy and supports light, dark, and
system themes.

| Tab | Current capabilities |
| --- | --- |
| Overview | Account/model health, request and token totals, cache-aware and no-cache cost estimates, latency, speed, quota summaries, and exposed models |
| Accounts | Provider onboarding, OAuth/reauthentication, quotas, account priority/location/capacity, unblock/reset actions, and default passthrough selection |
| Aliases | Guided redirect/fallback/local-cloud policies, advanced schema-v2 editing, simulation, live capacity inspection, and image-model override |
| API keys | Dynamic application keys, deferred-job fairness weights, and signed result webhooks |
| Tracing | Paginated requests, payload diagnostics, project attribution, cost/token/latency views, time ranges, and ZIP export |
| API reference | Endpoint documentation, generated examples, model selection, and a live request console |

<details>
<summary>Dashboard gallery</summary>

All screenshots use sanitized mode (`?sanitized=1`).

### Overview

![Overview dashboard](./assets/screen-overview.jpg)

### Accounts

![Accounts dashboard](./assets/screen-accounts.jpg)

### Tracing

![Tracing dashboard](./assets/screen-tracing.jpg)

### API reference

![API reference dashboard](./assets/screen-docs.jpg)

</details>

---

## 🔌 Providers and onboarding

| Provider | Authentication | Notes |
| --- | --- | --- |
| OpenAI / ChatGPT | Browser callback or device OAuth | Uses ChatGPT/Codex account tokens, automatic refresh, model discovery, and quota-aware rotation |
| OpenAI-compatible | Base URL plus API key | Works with hosted or local compatible servers; location can be inferred or set to `local`/`cloud` |
| OpenCode Zen / Go | Console API key or official device OAuth | Discovers the account API root; Go usage can expose rolling 5-hour, weekly, and monthly windows |
| Mistral | API key | Manual account entry with Responses or compatibility bridging |
| z.ai | Coding Plan API key | Uses the Coding Plan chat-completions endpoint and exposes discovered z.ai models |
| Grok Build | xAI device OAuth or official CLI `auth.json` import | Uses the subscription contract and CLI headers rather than pay-per-token `XAI_API_KEY` billing |

### OpenAI

For browser OAuth, MultiVibe opens the authorization page and asks you to paste
the full callback URL after login. Device OAuth is usually simpler on a remote
or headless host: approve the one-time code and the dashboard completes the
flow automatically.

The bundled OpenAI client ID is registered for this browser callback:

~~~text
http://localhost:1455/auth/callback
~~~

Keep this localhost callback for the copy-and-paste flow even when MultiVibe is
remote, or use device OAuth. A different `OAUTH_REDIRECT_URI` also requires an
`OAUTH_CLIENT_ID` whose provider registration includes that exact URI.

### OpenCode

Choose **OpenCode Zen / Go** to enter an API key, or use **Connect OpenCode
account** for the official `opencode-cli` device flow. Quota endpoints are not
available for every plan; unsupported usage is displayed as `N/A` without
disabling routing.

### Grok Build

Grok Build device OAuth is the preferred option. Existing official CLI
credentials can be imported from `XAI_AUTH_PATH`; `xai::api_key` and deprecated
pre-OIDC `web_login` entries are ignored. If the CLI and MultiVibe run
concurrently, prefer separate device authorization because refresh tokens
rotate.

To import a host file into Docker, mount it read-only:

~~~yaml
services:
  multivibe:
    environment:
      - XAI_AUTH_PATH=/run/secrets/grok-auth.json
    volumes:
      - /absolute/path/to/.grok/auth.json:/run/secrets/grok-auth.json:ro
~~~

Grok Build subscription access is intended for the account owner or another
trusted operator. Review current provider terms before offering it to other
users.

---

## 🔗 API surface

### Authentication

| Surface | Authentication |
| --- | --- |
| Dashboard and `/admin/*` | `ADMIN_TOKEN` through the login session, `x-admin-token`, or Bearer token |
| Inference, jobs, capacity, Realtime, and WebSocket | `PROXY_API_KEY` or an entry from `PROXY_API_KEYS`/the dashboard; Bearer and `x-api-key` are accepted |
| Codex project registration | `CODEX_PROJECT_REGISTRATION_TOKEN` through `x-codex-project-token` |
| `/health` and static dashboard assets | Unauthenticated |

When no proxy key is configured, inference routes are open. Each application
key records its application name in traces and isolates its deferred jobs.
Applications still share the provider account pool and quota state; deferred
scheduling fairness and result webhooks are configured per application.

### Public endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/v1/models`, `/v1/models/:id` | Discovered models and enabled aliases |
| `POST` | `/v1/responses` | OpenAI Responses; JSON, SSE, or WebSocket |
| `POST` | `/v1/responses/compact` | Responses compaction |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions; JSON or SSE |
| `POST` | `/v1/messages` | Anthropic Messages compatibility; JSON or SSE |
| `POST` | `/v1/realtime/calls` | Realtime WebRTC SDP negotiation |
| `GET` | `/v1/realtime/voices`, `/v1/settings/voices` | ChatGPT voice eligibility and catalog |
| `GET` | `/v1/capacity`, `/v1/capacity/events` | Application-visible capacity snapshot and resumable SSE |
| `GET`/`DELETE` | `/v1/jobs/*` | Deferred job state, events, results, and cancellation |

Inference and model routes are also exposed without `/v1`. Discovery
compatibility routes include `/api/v1/models`, `/api/tags`, `/version`,
`/props`, and `/v1/props`.

The model IDs in the examples are illustrative. Replace them with a model or
enabled alias returned by your own `GET /v1/models` response.

### Responses example

~~~bash
curl -X POST http://localhost:1455/v1/responses \
  -H "Authorization: Bearer $MULTIVIBE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-5.3-codex",
    "input": "Explain quota-aware routing in one sentence."
  }'
~~~

Set `"stream": true` and use `curl -N` for SSE.

### Chat Completions example

~~~bash
curl -X POST http://localhost:1455/v1/chat/completions \
  -H "Authorization: Bearer $MULTIVIBE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-5.3-codex",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
~~~

### Anthropic Messages example

~~~bash
curl -X POST http://localhost:1455/v1/messages \
  -H "x-api-key: $MULTIVIBE_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-5.3-codex",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
~~~

MultiVibe maps Anthropic text, images, tools, tool results, usage, errors, and
stream events to the selected upstream dialect.

### Responses over WebSocket

Connect to `ws://localhost:1455/v1/responses`, authenticate during the upgrade,
and send Codex-style `response.create` frames:

~~~js
import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:1455/v1/responses", {
  headers: { Authorization: "Bearer " + process.env.MULTIVIBE_API_KEY },
});

ws.on("open", () => {
  ws.send(JSON.stringify({
    type: "response.create",
    model: "gpt-5.3-codex",
    input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
    stream: true,
  }));
});
~~~

WebSocket transport is available for `/responses` only.
This is a Node.js example using the installed `ws` package; browser WebSocket
clients cannot attach the required authorization header during the handshake.

### Realtime voice

MultiVibe proxies the native multipart SDP handshake; audio then flows directly
over the negotiated WebRTC connection. By default it selects an eligible
OpenAI/ChatGPT account:

~~~dotenv
REALTIME_PROVIDER=openai
~~~

To use a billed OpenAI-compatible Realtime API account, opt in explicitly:

~~~dotenv
REALTIME_PROVIDER=openai-compatible
REALTIME_WEBRTC_CALL_URL=https://api.openai.com/v1/realtime/calls
~~~

This mode is never selected silently as a fallback from a ChatGPT subscription.

---

## 🧠 Routing strategy

### Direct provider models

For a discovered model, MultiVibe:

1. Builds the enabled account/provider candidate pool.
2. Excludes active account/model blocks and unsupported model mappings.
3. Avoids a five-hour window near its configured threshold while another
   eligible candidate remains.
4. Normally prefers the lowest known weekly usage; equal quota tiers alternate
   across requests.
5. Only when every effective candidate is near its five-hour limit, prefers the
   greatest known remaining five-hour headroom.
6. Uses weekly reset timing and configured priority as secondary ordering signals.
7. Rotates on quota-like failures and retries bounded transient upstream errors.

Optional `CODEX_SESSION_AFFINITY` keeps a session on the same eligible account
per application and provider. Affinity never bypasses quota or policy filters.

### Smart aliases

Aliases are schema-v2 policies. The first matching rule can inspect:

- application and priority;
- reasoning effort and input size;
- text/image/audio/video modalities;
- tool requirements and execution mode;
- day/time windows.

Constraints filter candidates by local/cloud location, predicted wait, context
window, and quality. Remaining candidates are scored for latency, cost,
quality, and locality. Capacity comes from configured profiles, requests in
flight, quota blocks, health/metrics probes, and learned throughput.

Rules can continue to the next rule, queue work, or reject when no destination
has capacity. Optional cloud budgets emit application-scoped warnings.

The dashboard includes guided redirect, ordered fallback, and local-to-cloud
presets, plus an advanced editor and a no-inference policy simulator. Legacy
`targets` payloads are migrated to schema v2 when accepted.

### Image routing

`imageRequestModelOverride` can redirect image-bearing requests to a currently
exposed model or enabled alias. MultiVibe preserves image parts while bridging
Chat Completions `image_url` and Responses `input_image` payloads.

### Admission and deferred jobs

Inference routes accept these optional headers:

| Header | Values / meaning |
| --- | --- |
| `X-MultiVibe-Priority` | `critical`, `interactive`, `standard`, or `batch` |
| `X-MultiVibe-Execution` | `sync`, `auto`, or `defer` |
| `X-MultiVibe-Max-Wait-Ms` | Maximum admission wait |
| `X-MultiVibe-Deadline` | RFC 3339 completion deadline with timezone, for example `2026-09-01T18:00:00Z` |
| `X-MultiVibe-Idempotency-Key` | Stable application idempotency key |
| `X-MultiVibe-Webhook` | Registered application webhook ID |

Without opt-in headers, requests retain synchronous behavior unless the selected
alias defines defaults. Streaming, WebSocket, and Realtime requests cannot be
deferred. A deferred request returns `202 Accepted` and a `multivibe.job`.

For an authenticated, synchronous JSON inference, the same idempotency header
also enables a short in-memory single-flight and replay window. The key is
isolated by application and inference route. Reusing it with a different JSON
payload returns `409`; concurrent duplicates share one execution. Responses
include `X-MultiVibe-Idempotency-Status` with `created`, `coalesced`, `replayed`,
or `bypass`.

Direct inference replay is intentionally limited to text-only, non-streaming,
stateless requests without tools. Streaming, tool, multimodal, stored,
background, and conversation-linked requests bypass this layer. Errors,
partial results, tool-call responses, and responses over the configured byte
limit are shared only with already waiting followers and are not retained.

~~~bash
curl -X POST http://localhost:1455/v1/responses \
  -H "Authorization: Bearer $MULTIVIBE_API_KEY" \
  -H "content-type: application/json" \
  -H "X-MultiVibe-Priority: batch" \
  -H "X-MultiVibe-Execution: defer" \
  -H "X-MultiVibe-Idempotency-Key: nightly-translation-42" \
  -d '{"model": "gpt-5.3-codex", "input": "..."}'
~~~

Job endpoints are application-isolated:

- `GET /v1/jobs` and `GET /v1/jobs/:id`
- `GET /v1/jobs/:id/result`
- `GET /v1/jobs/:id/events` with `Last-Event-ID`
- `DELETE /v1/jobs/:id`

Successful responses may include `X-MultiVibe-Decision`,
`X-MultiVibe-Resolved-Model`, `X-MultiVibe-Estimated-Wait-Ms`, and
`X-MultiVibe-Capacity-Version`.

For retention, retries, event types, HMAC signatures, polling, and
application-side idempotency, read the
[deferred batch integration guide](./docs/batch-jobs.md). The repository also
contains a reusable [implementation prompt](./docs/prompts/implement-multivibe-batch.md).

---

## 📈 Tracing and project attribution

Recent traces and lightweight historical aggregates are stored separately.
The dashboard and admin API expose request volume, tokens, cache usage,
estimated cost, latency, time to first token, inference speed, provider/model
selection, payload diagnostics, and time-range filtering.
Client request totals and error rates use the final response returned to the
caller, while provider attempts and recovered retries remain visible as routing
telemetry. High-volume control-plane routes such as admin polling, health, and
model discovery are not persisted as inference traces.

Useful admin endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /admin/traces?page=1&pageSize=100` | Paginated recent traces |
| `GET /admin/traces/:id` | Full retained trace |
| `GET /admin/traces/export.zip` | Filtered ZIP export |
| `GET /admin/stats/usage` | Usage by account, route, application, model, and project |
| `GET /admin/stats/traces` | Historical trace statistics |

`sinceMs` and `untilMs` are accepted by stats and export routes. Export also
supports `accountId`, `route`, and `projectId`.

Request bodies and headers are disabled in traces by default. When
`TRACE_INCLUDE_HEADERS=true`, names are retained but credentials, cookies,
tokens, session values, and similar secrets are redacted. Header values are not
copied into long-term history.

### Codex project attribution

The dashboard can generate an installer command for a user-level Codex
`SessionStart` hook. Install it once on every execution host, then review and
trust the hook with `/hooks` inside Codex.

Manual installation from this checkout:

~~~bash
read -s MULTIVIBE_PROJECT_TOKEN
export MULTIVIBE_PROJECT_TOKEN
node scripts/install-codex-project-hook.mjs --url https://multivibe.example
unset MULTIVIBE_PROJECT_TOKEN
~~~

The installer preserves existing `~/.codex/hooks.json` entries and stores its
secret with mode `0600`. Exact session mapping wins; deterministic
`X-MultiVibe-Project-Root` plus `X-MultiVibe-Project-Host` headers provide an
unambiguous fallback. `X-LiteLLM-Key-Alias` takes precedence when present.

Set a dedicated `CODEX_PROJECT_REGISTRATION_TOKEN` when possible. If it is
unset, `ADMIN_TOKEN` is used for compatibility; if both are empty, registration
is disabled.

---

## 💾 Persistence

Mount `/data` to preserve state:

| Default path | Contents |
| --- | --- |
| `/data/accounts.json` | Accounts, aliases, dashboard API keys, application policies, webhooks, and settings |
| `/data/oauth-state.json` | In-progress OAuth state |
| `/data/requests-trace.jsonl` | Recent retained traces |
| `/data/requests-stats-history.jsonl` | Lightweight long-term usage history |
| `/data/codex-projects.json` | Codex session/project registry |
| `/data/jobs.sqlite` | Durable jobs, leases, results, and events |

The Compose deployment mounts `./data:/data`. Recent trace retention defaults
to 1,000 entries. Persistent state is not encrypted at rest: `accounts.json`
can contain provider access/refresh tokens, proxy keys, and webhook secrets;
`oauth-state.json` can contain temporary OAuth verifiers; traces and the jobs
database can contain request and response payloads. Files created by MultiVibe
use restrictive permissions, but the volume and its backups should still be
encrypted, access-controlled, and excluded from public shares.

Job content delivered by webhook or consumed by a client receives a one-hour
grace period; unretrieved content is purged after 30 days. For a consistent
backup, stop the service cleanly, copy the entire `data/` directory (including
any SQLite `-wal` and `-shm` files), then start it again. Restore the complete
directory only while the service is stopped.

---

## ⚙️ Configuration

The tables below separate application defaults from the effective values in the
shipped Compose profile.

| Variable | Compose value | Note |
| --- | --- | --- |
| `ADMIN_TOKEN` | `change-me` | Unsafe placeholder; replace it before first use as shown above |
| `PROXY_API_KEY` | empty unless set in `.env` | Empty leaves inference routes open |
| `REQUEST_BODY_LIMIT` | `500mb` | Overrides the `100mb` application default |
| `MODELS_CLIENT_VERSION` | `1.0.0` | Overrides the application default |
| `PROXY_MODELS` | `gpt-5.5` | Last of two Compose entries, so it is the effective value |
| `EXCLUDED_PROVIDER_MODELS` | `openai-compatible:gpt-5.5,mistral:mistral-medium-latest` | Overrides the empty application default |

Compose uses `.env` for interpolation only. Variables not listed under the
service's `environment` section must be added there or supplied by an override
file before they reach the container.

### Core settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `1455` | HTTP server port |
| `ADMIN_TOKEN` | empty | Dashboard/admin secret; empty disables the admin check |
| `PROXY_API_KEY` | empty | Shared inference/API key |
| `PROXY_API_KEYS` | empty | JSON object mapping application names to keys |
| `STORE_PATH` | `/data/accounts.json` | Account and dashboard-managed state |
| `OAUTH_STATE_PATH` | `/data/oauth-state.json` | OAuth state |
| `TRACE_FILE_PATH` | `/data/requests-trace.jsonl` | Recent traces |
| `TRACE_STATS_HISTORY_PATH` | `/data/requests-stats-history.jsonl` | Long-term lightweight usage |
| `CODEX_PROJECTS_PATH` | `/data/codex-projects.json` | Codex project registry |
| `JOBS_DB_PATH` | `/data/jobs.sqlite` | Deferred jobs database |
| `JOB_WORKER_CONCURRENCY` | `16` | Global worker concurrency; destination capacity still applies |
| `REQUEST_BODY_LIMIT` | `100mb` | JSON or decompressed-zstd body limit |
| `TRACE_RETENTION_MAX` | `1000` | Recent full traces retained; minimum 100 |
| `TRACE_INCLUDE_BODY` | `false` | Persist full request bodies in recent traces |
| `TRACE_INCLUDE_HEADERS` | `false` | Persist sanitized inbound headers in recent traces |
| `CODEX_PROJECT_REGISTRATION_TOKEN` | `ADMIN_TOKEN` | Limited project-registration secret |
| `CODEX_SESSION_AFFINITY` | `false` | In-memory per-session account stickiness |
| `CODEX_SESSION_AFFINITY_MAX_ENTRIES` | `10000` | Affinity cache limit |
| `INFERENCE_IDEMPOTENCY_TTL_MS` | `300000` | Completed synchronous inference replay TTL |
| `INFERENCE_IDEMPOTENCY_IN_FLIGHT_TIMEOUT_MS` | `300000` | Maximum single-flight reservation lifetime |
| `INFERENCE_IDEMPOTENCY_MAX_ENTRIES` | `1000` | Combined in-flight and completed entry limit |
| `INFERENCE_IDEMPOTENCY_MAX_BYTES` | `33554432` | Global completed-response memory budget |
| `INFERENCE_IDEMPOTENCY_MAX_RESPONSE_BYTES` | `1048576` | Per-response replay limit |
| `PROXY_MODELS` | `gpt-5.3-codex,gpt-5.2-codex,gpt-5-codex` | Fallback model catalog |
| `MODELS_CLIENT_VERSION` | `0.144.1` | Codex identity used for discovery/runtime requests |
| `MODELS_CACHE_MS` | `600000` | Model-catalog refresh interval |
| `EXCLUDED_PROVIDER_MODELS` | empty | Comma-separated `provider:model` exclusions |
| `CLAUDE_CODE_MODEL` | `gpt-5.6-luna` | Claude Code opus/sonnet upstream |
| `CLAUDE_CODE_FAST_MODEL` | `gpt-5.4-mini` | Claude Code haiku/fast upstream |

<details>
<summary>Routing, cache, retry, and block tuning</summary>

| Variable | Default | Purpose |
| --- | --- | --- |
| `USAGE_CACHE_TTL_MS` | `300000` | Usage snapshot freshness |
| `USAGE_TIMEOUT_MS` | `10000` | Provider usage-probe timeout |
| `USAGE_STALE_WHILE_REVALIDATE` | `true` | Route with bounded stale/missing usage while refreshing |
| `USAGE_STALE_MAX_AGE_MS` | `1800000` | Maximum stale usage age |
| `MODELS_STALE_WHILE_REVALIDATE` | `true` | Serve a bounded stale model catalog while refreshing |
| `MODELS_STALE_MAX_AGE_MS` | `1800000` | Maximum stale catalog age |
| `FIVE_HOUR_QUOTA_THRESHOLD_PERCENT` | `90` | Near-limit five-hour threshold |
| `BLOCK_FALLBACK_MS` | `1800000` | Quota block fallback without a usable reset |
| `RATE_LIMIT_BLOCK_MS` | `60000` | Ordinary rate-limit account/model block |
| `MODEL_NOT_FOUND_BLOCK_DURATION_MS` | `3600000` | Model-not-found account/model block |
| `MAX_ACCOUNT_RETRY_ATTEMPTS` | `10` | Candidate accounts tried after quota failures |
| `MAX_UPSTREAM_RETRIES` | `5` | Same-account transient retries |
| `UPSTREAM_BASE_DELAY_MS` | `2000` | Retry backoff base |
| `HANG_RETRY_INTERVAL_MS` | `10000` | Delay while all accounts are temporarily exhausted |
| `HANG_RETRY_MAX_DURATION_MS` | `120000` | Maximum all-account wait |
| `EMPTY_RESPONSE_BLOCK_THRESHOLD` | `3` | Empty outputs before a temporary block |
| `EMPTY_RESPONSE_BLOCK_DURATION_MS` | `30000` | Empty-output block duration |
| `EMPTY_RESPONSE_WINDOW_MS` | `300000` | Empty-output counting window |
| `TOKEN_REFRESH_MARGIN_MS` | `60000` | OAuth refresh margin |
| `ACCOUNT_FLUSH_INTERVAL_MS` | `5000` | Account-store write debounce |

</details>

<details>
<summary>Provider, OAuth, Realtime, and observability settings</summary>

| Variable | Default |
| --- | --- |
| `CHATGPT_BASE_URL` | `https://chatgpt.com` |
| `UPSTREAM_PATH` | `/backend-api/codex/responses` |
| `UPSTREAM_COMPACT_PATH` | `/backend-api/codex/responses/compact` |
| `MISTRAL_BASE_URL` | `https://api.mistral.ai` |
| `OPENCODE_BASE_URL` | `https://opencode.ai/zen` |
| `OPENCODE_CONSOLE_URL` | `https://opencode.ai/console` |
| `OPENCODE_OAUTH_CLIENT_ID` | `opencode-cli` |
| `ZAI_BASE_URL` | `https://api.z.ai` |
| `ZAI_MODELS_PATH` | `/api/paas/v4/models` |
| `XAI_BASE_URL` | `https://cli-chat-proxy.grok.com/v1` |
| `XAI_AUTH_PATH` | `$HOME/.grok/auth.json` |
| `OAUTH_REDIRECT_URI` | `http://localhost:1455/auth/callback` |
| `REALTIME_PROVIDER` | `openai` |
| `REALTIME_WEBRTC_CALL_URL` | empty |
| `REALTIME_REQUEST_TIMEOUT_MS` | `30000` |
| `SENTRY_DSN` | empty |
| `SENTRY_ENVIRONMENT` | `NODE_ENV` or `production` |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.1` |

Provider endpoint paths, OAuth endpoints, and Grok client-identity fields can
also be overridden. The authoritative definitions live in
[`src/config.ts`](./src/config.ts) and
[`src/oauth-config.ts`](./src/oauth-config.ts).

</details>

---

## 🛠️ Local development

Use Node.js 22 or later. The repository has separate API and web lockfiles:

~~~bash
npm ci
npm --prefix web ci
~~~

Application storage defaults to `/data`, which is normally writable only in
the container. Point all persistent paths at the ignored checkout-local
`data/` directory before running the API directly:

~~~bash
mkdir -p data
export STORE_PATH="$PWD/data/accounts.json"
export OAUTH_STATE_PATH="$PWD/data/oauth-state.json"
export TRACE_FILE_PATH="$PWD/data/requests-trace.jsonl"
export TRACE_STATS_HISTORY_PATH="$PWD/data/requests-stats-history.jsonl"
export CODEX_PROJECTS_PATH="$PWD/data/codex-projects.json"
export JOBS_DB_PATH="$PWD/data/jobs.sqlite"
~~~

Set non-placeholder `ADMIN_TOKEN` and `PROXY_API_KEY` values as well if the
development server is reachable beyond your machine. Build the dashboard once
before starting the watched API server:

~~~bash
npm run build:web
npm run dev
~~~

Production-style validation:

~~~bash
npm run build
npm test
npm start
~~~

Available scripts:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Watch the TypeScript API server |
| `npm run build:web` | Type-check and build the React dashboard |
| `npm run build:api` | Compile the API |
| `npm run build` | Build dashboard and API |
| `npm test` | Run the Node test suite |
| `npm start` | Run the compiled server with instrumentation |

---

## 📚 Additional documentation

- [Deferred batch integration](./docs/batch-jobs.md)
- [Reusable batch implementation prompt](./docs/prompts/implement-multivibe-batch.md)
- [Reliability and performance audit](./docs/reliability-performance-audit-2026-08-23.md)
- [Tracing page audit](./docs/tracing-page-audit.md)
- [Official logo kit and usage guidance](./assets/brand/README.md)

Benchmark reports and targeted performance investigations are available in
[`docs/`](./docs/).

---

## 🤝 Contributing

Focused pull requests and issues are welcome. For UI changes, include a
before/after description and screenshots. For behavior changes, add or update
tests and report the validation commands you ran.

---

## 👥 Contributors

<a href="https://github.com/thibautrey/multivibe/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=thibautrey/multivibe" alt="MultiVibe contributors" />
</a>

Thanks to everyone who has helped improve MultiVibe. This gallery is generated
from GitHub's contributor graph and updates automatically.

[View all contributors and their commits](https://github.com/thibautrey/multivibe/graphs/contributors).

---

## ⭐ Star history

<a href="https://www.star-history.com/#thibautrey/multivibe&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=thibautrey/multivibe&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=thibautrey/multivibe&type=Date&theme=light" />
    <img alt="MultiVibe Star History chart" src="https://api.star-history.com/svg?repos=thibautrey/multivibe&type=Date&theme=light" />
  </picture>
</a>
