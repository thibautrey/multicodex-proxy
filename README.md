# multicodex-proxy

Proxy OpenAI-compatible (`/v1/chat/completions`, `/v1/responses`) with **multi-account Codex rotation** inspired by `pi-multicodex`.

## What it does

- Uses multiple OpenAI/Codex accounts (token per account)
- Probes ChatGPT quota windows (`/backend-api/wham/usage`)
- Selection heuristic:
  1. prefer accounts untouched on both windows (0% / 0%)
  2. otherwise prefer account with soonest weekly reset
  3. fallback by priority
- On 429/quota-like errors, blocks account until reset (or fallback cooldown) and retries with next account
- Stores everything in a **plain JSON file** (`/data/accounts.json`)

## Limits / assumptions

- Upstream defaults to `https://chatgpt.com/backend-api/codex/responses`
- This is geared to OAuth-style access tokens similar to multicodex usage
- If your upstream format differs, adapt `UPSTREAM_PATH` and/or payload mapping

## Run with Docker

```bash
docker compose up -d --build
```

Service: `http://localhost:4010`

## Configure accounts

Set `ADMIN_TOKEN` in `docker-compose.yml`, then:

```bash
curl -X POST http://localhost:4010/admin/accounts \
  -H 'content-type: application/json' \
  -H 'x-admin-token: change-me' \
  -d '{
    "id": "acc-1",
    "email": "you@example.com",
    "accessToken": "<oauth_access_token>",
    "chatgptAccountId": "optional-account-id",
    "enabled": true,
    "priority": 10
  }'
```

List accounts:

```bash
curl http://localhost:4010/admin/accounts -H 'x-admin-token: change-me'
```

Unblock account manually:

```bash
curl -X POST http://localhost:4010/admin/accounts/acc-1/unblock -H 'x-admin-token: change-me'
```

## Proxy usage

Point your client to:

- `http://localhost:4010/v1/chat/completions`
- `http://localhost:4010/v1/responses`

Body is forwarded upstream as-is.

## Local dev

```bash
npm install
npm run dev
```
