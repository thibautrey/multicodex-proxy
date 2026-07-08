# MultiVibe

<p align="center">
  <strong>OpenAI-compatible multi-provider router</strong><br/>
  <sub>Quota-aware routing • OAuth onboarding • Persistent storage • Request tracing • Automatic model discovery</sub>
</p>

<p align="center">
<a href="https://github.com/thibautrey/multicodex-proxy/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/thibautrey/multicodex-proxy?style=for-the-badge"/></a>
  <a href="https://github.com/thibautrey/multicodex-proxy/network/members"><img alt="GitHub forks" src="https://img.shields.io/github/forks/thibautrey/multicodex-proxy?style=for-the-badge"/></a>
  <a href="https://github.com/thibautrey/multicodex-proxy/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/thibautrey/multicodex-proxy?style=for-the-badge"/></a>
</p>

---

## ✨ What it does

MultiVibe acts as an OpenAI-compatible gateway that lets you route requests across multiple provider accounts while keeping a single API surface. The same proxy routes are exposed under `/v1` and at the root path for clients that expect either style.

- **OpenAI-compatible API**
  - `GET /v1/models`
  - `GET /v1/models/:id`
  - `POST /v1/chat/completions`
  - `POST /v1/responses`
  - `POST /v1/responses/compact`
  - root-path aliases: `/models`, `/chat/completions`, `/responses`, `/responses/compact`
  - compatibility endpoints: `/api/v1/models`, `/api/tags`, `/version`, `/props`, `/v1/props`
- **Streaming over SSE or WebSocket**
  - HTTP streaming uses plain `POST` with `stream: true`
  - HTTP response stream is `text/event-stream`
  - `/v1/responses` also accepts `ws://` / `wss://` and Codex-style JSON `response.create` frames
  - `/v1/chat/completions` and `/v1/responses/compact` remain HTTP-only
- **Multi-account routing** with quota-aware failover across OpenAI, OpenAI-compatible, Mistral, and z.ai accounts
- **Model aliases** (for example `small`) with ordered fallback across providers/models, including optional effort-qualified targets like `high:gpt-5.3-codex`
- **Image-aware routing override** that can route image-bearing requests to a chosen exposed model or alias while preserving the originally requested model in traces
- **OAuth onboarding** from dashboard with browser callback or device-code flow
- **Manual OpenAI-compatible connections** with custom `baseUrl` + API key
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

### Playground

![Playground](./assets/screen-playground.jpg)

### API docs tab

![Docs](./assets/screen-docs.jpg)

---

## 🧠 Routing strategy

When a request arrives, MultiVibe resolves the requested model to a provider and chooses an account with this strategy:

1. Prefer accounts untouched on both windows (5h + weekly)
2. Otherwise prefer account with nearest weekly reset
3. Fallback by priority
4. On `429`/quota-like errors, temporarily block the account+model and retry on the next candidate

When the requested model is an alias, MultiVibe resolves it to ordered target models and automatically falls back across target models/providers as quotas are hit.

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

Recent trace retention defaults to the latest **1000** entries and can be changed with `TRACE_RETENTION_MAX`.
Stats history is append-only and keeps lightweight request metadata for long-term cost/volume tracking.

> Docker compose already mounts `./data:/data`.

---

## 🚀 Quick start (Docker)

```bash
docker compose up -d --build
```

- Dashboard: `http://localhost:1455`
- Health: `http://localhost:1455/health`

---

## 🔐 OAuth onboarding flow

Because this is often deployed remotely (Unraid/VPS), OpenAI onboarding supports both browser callback and device-code flows. The browser callback flow uses a manual redirect paste step:

1. Open dashboard
2. For OpenAI accounts, enter the account email
3. Choose **Browser callback** and click **Start OAuth**
4. Complete login in browser
5. Copy the full redirect URL shown after the callback completes
6. Paste that URL in the dashboard and click **Complete OAuth**

For headless or remote setups, choose **Device code** instead. The dashboard opens
the verification page, shows a one-time code, and completes automatically after
you approve the login.

Mistral, z.ai, and generic OpenAI-compatible accounts use manual token/API-key entry in the dashboard. Generic OpenAI-compatible accounts also require a `baseUrl`.

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

### Create model alias

```bash
curl -X POST http://localhost:1455/admin/model-aliases \
  -H "x-admin-token: change-me" \
  -H "content-type: application/json" \
  -d '{
    "id": "small",
    "targets": ["gpt-5.1-codex-mini", "devstral-small-latest"],
    "enabled": true,
    "description": "Small coding model pool"
  }'
```

Targets may also be effort-qualified:

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
- `sinceMs=<epoch_ms>`
- `untilMs=<epoch_ms>`

Model alias admin endpoints:

- `GET /admin/model-aliases`
- `POST /admin/model-aliases`
- `PATCH /admin/model-aliases/:id`
- `DELETE /admin/model-aliases/:id`

Settings endpoints:

- `GET /admin/settings`
- `PATCH /admin/settings`

OAuth admin endpoints:

- `POST /admin/oauth/start`
- `GET /admin/oauth/status/:flowId`
- `POST /admin/oauth/complete`
- `POST /admin/oauth/device/poll`

---

## ⚙️ Environment variables

| Variable                          | Default                                   | Description                                                         |
| --------------------------------- | ----------------------------------------- | ------------------------------------------------------------------- |
| `PORT`                            | `1455`                                    | HTTP server port                                                    |
| `STORE_PATH`                      | `/data/accounts.json`                     | Accounts, aliases, and settings store                               |
| `OAUTH_STATE_PATH`                | `/data/oauth-state.json`                  | OAuth flow state                                                    |
| `TRACE_FILE_PATH`                 | `/data/requests-trace.jsonl`              | Recent request trace file                                           |
| `TRACE_STATS_HISTORY_PATH`        | `/data/requests-stats-history.jsonl`      | Lightweight request history for long-term stats                     |
| `TRACE_RETENTION_MAX`             | `1000`                                    | Number of recent full traces to retain; minimum effective value is 100 |
| `TRACE_INCLUDE_BODY`              | `false`                                   | Persist full request payloads when explicitly enabled; trace stats still work when disabled |
| `REQUEST_BODY_LIMIT`              | `100mb`                                   | Max accepted JSON or decompressed zstd request body size            |
| `PROXY_MODELS`                    | `gpt-5.3-codex,gpt-5.2-codex,gpt-5-codex` | Fallback comma-separated model list for `/v1/models`                |
| `MODELS_CLIENT_VERSION`           | `1.0.0`                                   | Version sent to `/backend-api/codex/models` for OpenAI model discovery |
| `MODELS_CACHE_MS`                 | `600000`                                  | Model discovery cache duration (ms)                                 |
| `ADMIN_TOKEN`                     | empty                                     | Admin endpoints auth token; empty disables the admin-token check    |
| `CHATGPT_BASE_URL`                | `https://chatgpt.com`                     | OpenAI/ChatGPT upstream base URL                                    |
| `UPSTREAM_PATH`                   | `/backend-api/codex/responses`            | OpenAI upstream request path                                        |
| `UPSTREAM_COMPACT_PATH`           | `/backend-api/codex/responses/compact`    | OpenAI upstream path for `/v1/responses/compact`                    |
| `MISTRAL_BASE_URL`                | `https://api.mistral.ai`                  | Mistral upstream base URL                                           |
| `MISTRAL_UPSTREAM_PATH`           | `/v1/responses`                           | Mistral upstream path for responses                                 |
| `MISTRAL_COMPACT_UPSTREAM_PATH`   | `/v1/responses/compact`                   | Mistral upstream path for compact responses                         |
| `ZAI_BASE_URL`                    | `https://api.z.ai`                        | z.ai upstream base URL                                              |
| `ZAI_UPSTREAM_PATH`               | `/v1/chat/completions`                    | z.ai upstream path for responses routed through chat completions    |
| `ZAI_COMPACT_UPSTREAM_PATH`       | `/v1/chat/completions`                    | z.ai upstream path for compact responses                            |
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
| `MAX_ACCOUNT_RETRY_ATTEMPTS`      | `10`                                      | Max accounts to try on quota/rate-limit errors                      |
| `MAX_UPSTREAM_RETRIES`            | `5`                                       | Retries per upstream request (429/5xx)                              |
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

## 📈 Star history

<a href="https://star-history.com/#thibautrey/multicodex-proxy&Date">
  <img src="https://api.star-history.com/svg?repos=thibautrey/multicodex-proxy&type=Date" alt="Star History Chart" />
</a>

---

## 🤝 Contributing

PRs and issues are welcome.

If you open a PR:

- keep it focused
- include before/after behavior
- include screenshots for UI changes
