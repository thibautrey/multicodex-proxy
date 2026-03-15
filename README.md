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

MultiVibe acts as an OpenAI-compatible gateway that lets you route requests across multiple provider accounts while keeping a single `/v1` API surface:

- **OpenAI-compatible API**
  - `GET /v1/models`
  - `GET /v1/models/:id`
  - `POST /v1/chat/completions`
  - `POST /v1/responses`
  - `POST /v1/responses/compact`
- **Multi-account routing** with quota-aware failover
- **Model aliases** (for example `small`) with ordered fallback across providers/models
- **OAuth onboarding** from dashboard (manual redirect paste flow)
- **Persistent account storage** across container restarts
- **Request tracing v2** (retention capped at 1000, server pagination, tokens/model/error/latency stats, optional full payload)
- **Usage stats endpoint** with global + per-account + per-route aggregates over full history
- **Time-range stats** (`sinceMs` / `untilMs`) while keeping only the latest 1000 full traces

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

When a request arrives, MultiVibe chooses an account with this strategy:

1. Prefer accounts untouched on both windows (5h + weekly)
2. Otherwise prefer account with nearest weekly reset
3. Fallback by priority
4. On `429`/quota-like errors, block account and retry on next

When the requested model is an alias, MultiVibe resolves it to ordered target models and automatically falls back across target models/providers as quotas are hit.

---

## 📦 Persistence

Everything important is file-based and survives restart (if `/data` is mounted):

- `/data/accounts.json`
- `/data/oauth-state.json`
- `/data/requests-trace.jsonl`
- `/data/requests-stats-history.jsonl`

Trace retention is capped to the latest **1000** entries.
Stats history is append-only and keeps lightweight request metadata for long-term cost/volume tracking.

> Docker compose already mounts `./data:/data`.

---

## 🚀 Quick start (Docker)

```bash
docker compose up -d --build
```

- Dashboard: `http://localhost:4010`
- Health: `http://localhost:4010/health`

---

## 🔐 OAuth onboarding flow

Because this is often deployed remotely (Unraid/VPS), onboarding uses a manual redirect paste flow:

1. Open dashboard
2. For OpenAI accounts, enter the account email
3. Click **Start OAuth**
4. Complete login in browser
5. Copy the full redirect URL shown after the callback completes
6. Paste that URL in the dashboard and click **Complete OAuth**

Mistral accounts still use manual token entry in the dashboard.

Default expected redirect URI:

```text
http://localhost:1455/auth/callback
```

---

## 🧪 API examples

### List models

```bash
curl http://localhost:4010/v1/models
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
curl -X POST http://localhost:4010/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-5.3-codex",
    "messages": [{"role":"user","content":"hello"}]
  }'
```

### Create model alias

```bash
curl -X POST http://localhost:4010/admin/model-aliases \
  -H "x-admin-token: change-me" \
  -H "content-type: application/json" \
  -d '{
    "id": "small",
    "targets": ["gpt-5.1-codex-mini", "devstral-small-latest"],
    "enabled": true,
    "description": "Small coding model pool"
  }'
```

### Read traces

```bash
# Paginated API (recommended)
curl -H "x-admin-token: change-me" \
  "http://localhost:4010/admin/traces?page=1&pageSize=100"
```

```bash
# Legacy compatibility mode
curl -H "x-admin-token: change-me" \
  "http://localhost:4010/admin/traces?limit=50"
```

### Usage stats

```bash
curl -H "x-admin-token: change-me" \
  "http://localhost:4010/admin/stats/usage?sinceMs=1735689600000&untilMs=1738291200000"
```

### Trace stats (historical)

```bash
curl -H "x-admin-token: change-me" \
  "http://localhost:4010/admin/stats/traces?sinceMs=1735689600000&untilMs=1738291200000"
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

---

## ⚙️ Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4010` | HTTP server port |
| `STORE_PATH` | `/data/accounts.json` | Accounts store |
| `OAUTH_STATE_PATH` | `/data/oauth-state.json` | OAuth flow state |
| `TRACE_FILE_PATH` | `/data/requests-trace.jsonl` | Request trace file (retained to latest 1000 entries) |
| `TRACE_STATS_HISTORY_PATH` | `/data/requests-stats-history.jsonl` | Lightweight request history for long-term stats |
| `TRACE_INCLUDE_BODY` | `true` | Persist full request payloads; trace stats still work when disabled |
| `PROXY_MODELS` | `gpt-5.3-codex,gpt-5.2-codex,gpt-5-codex` | Fallback comma-separated model list for `/v1/models` |
| `MODELS_CLIENT_VERSION` | `1.0.0` | Version sent to `/backend-api/codex/models` for model discovery |
| `MODELS_CACHE_MS` | `600000` | Model discovery cache duration (ms) |
| `ADMIN_TOKEN` | `change-me` | Admin endpoints auth token |
| `CHATGPT_BASE_URL` | `https://chatgpt.com` | Upstream base URL |
| `UPSTREAM_PATH` | `/backend-api/codex/responses` | Upstream request path |
| `UPSTREAM_COMPACT_PATH` | `/backend-api/codex/responses/compact` | Upstream path for `/v1/responses/compact` |
| `OAUTH_CLIENT_ID` | `app_EMoamEEZ73f0CkXaXp7hrann` | OpenAI OAuth client id |
| `OAUTH_AUTHORIZATION_URL` | `https://auth.openai.com/oauth/authorize` | OAuth authorize endpoint |
| `OAUTH_TOKEN_URL` | `https://auth.openai.com/oauth/token` | OAuth token endpoint |
| `OAUTH_SCOPE` | `openid profile email offline_access` | OAuth scope |
| `OAUTH_REDIRECT_URI` | `http://localhost:1455/auth/callback` | Redirect URI |
| `MISTRAL_COMPACT_UPSTREAM_PATH` | `/v1/responses/compact` | Mistral upstream path for compact responses |

---

## 🛠️ Local dev

```bash
npm install
npm --prefix web install
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
