# MultiCodex Proxy

<p align="center">
  <strong>OpenAI-compatible multi-account Codex proxy</strong><br/>
  <sub>Quota-aware routing • OAuth onboarding • Persistent storage • Request tracing</sub>
</p>

<p align="center">
  <a href="https://github.com/thibautrey/multicodex-proxy/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/thibautrey/multicodex-proxy?style=for-the-badge"/></a>
  <a href="https://github.com/thibautrey/multicodex-proxy/network/members"><img alt="GitHub forks" src="https://img.shields.io/github/forks/thibautrey/multicodex-proxy?style=for-the-badge"/></a>
  <a href="https://github.com/thibautrey/multicodex-proxy/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/thibautrey/multicodex-proxy?style=for-the-badge"/></a>
</p>

---

## ✨ What it does

MultiCodex Proxy sits between your clients and OpenAI/Codex endpoints and gives you:

- **OpenAI-compatible API**
  - `GET /v1/models`
  - `GET /v1/models/:id`
  - `POST /v1/chat/completions`
  - `POST /v1/responses`
- **Multi-account routing** with quota-aware failover
- **OAuth onboarding** from dashboard (manual redirect paste flow)
- **Persistent account storage** across container restarts
- **Request tracing** (account used, status, latency, usage/tokens, optional full payload)

---

## 🖼️ Dashboard

<p align="center">
  <img src="./assets/dashboard-unraid.png" alt="MultiCodex Proxy dashboard running on Unraid" width="1100"/>
</p>

---

## 🧠 Routing strategy

When a request arrives, the proxy chooses an account with this strategy:

1. Prefer accounts untouched on both windows (5h + weekly)
2. Otherwise prefer account with nearest weekly reset
3. Fallback by priority
4. On `429`/quota-like errors, block account and retry on next

---

## 📦 Persistence

Everything important is file-based and survives restart (if `/data` is mounted):

- `/data/accounts.json`
- `/data/oauth-state.json`
- `/data/requests-trace.jsonl`

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
2. Enter account email
3. Click **Start OAuth**
4. Complete login in browser
5. Copy the full redirect URL shown by browser
6. Paste it in dashboard and click **Complete OAuth**

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

### Chat completion

```bash
curl -X POST http://localhost:4010/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-5.3-codex",
    "messages": [{"role":"user","content":"hello"}]
  }'
```

### Read traces

```bash
curl -H "x-admin-token: change-me" \
  "http://localhost:4010/admin/traces?limit=50"
```

---

## ⚙️ Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4010` | HTTP server port |
| `STORE_PATH` | `/data/accounts.json` | Accounts store |
| `OAUTH_STATE_PATH` | `/data/oauth-state.json` | OAuth flow state |
| `TRACE_FILE_PATH` | `/data/requests-trace.jsonl` | Request trace file |
| `TRACE_INCLUDE_BODY` | `true` | Persist full request payloads |
| `PROXY_MODELS` | `gpt-5.3-codex` | Comma-separated model list for `/v1/models` |
| `ADMIN_TOKEN` | `change-me` | Admin endpoints auth token |
| `CHATGPT_BASE_URL` | `https://chatgpt.com` | Upstream base URL |
| `UPSTREAM_PATH` | `/backend-api/codex/responses` | Upstream request path |
| `OAUTH_CLIENT_ID` | `app_EMoamEEZ73f0CkXaXp7hrann` | OpenAI OAuth client id |
| `OAUTH_AUTHORIZATION_URL` | `https://auth.openai.com/oauth/authorize` | OAuth authorize endpoint |
| `OAUTH_TOKEN_URL` | `https://auth.openai.com/oauth/token` | OAuth token endpoint |
| `OAUTH_SCOPE` | `openid profile email offline_access` | OAuth scope |
| `OAUTH_REDIRECT_URI` | `http://localhost:1455/auth/callback` | Redirect URI |

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

