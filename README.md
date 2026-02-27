# MultiCodex Proxy (Dashboard + OAuth + Quota-aware Rotation)

OpenAI-compatible proxy (`/v1/chat/completions`, `/v1/responses`) inspired by `pi-multicodex`, with:

- Multi-account Codex rotation
- 5h + weekly usage probing (`/backend-api/wham/usage`)
- Automatic account block/rotation on quota errors
- OAuth login flow from dashboard (email -> browser login -> token stored)
- React + TypeScript dashboard (shadcn-style cards/panels)
- File-based persistence in `/data`

## How selection works

1. Prefer accounts untouched on both windows (0% on 5h + weekly)
2. Else prefer account with weekly reset soonest
3. Else fallback by priority

On 429/quota-like errors, account is temporarily blocked until next reset (or fallback cooldown).

## Persisted files

- `/data/accounts.json`: accounts, tokens, usage, state
- `/data/oauth-state.json`: OAuth flow state tracking

## Run with Docker

```bash
docker compose up -d --build
```

Dashboard: `http://localhost:4010`
Proxy endpoints:
- `http://localhost:4010/v1/chat/completions`
- `http://localhost:4010/v1/responses`

## Dashboard workflow (OAuth)

1. Open dashboard
2. Set admin token (default in compose: `change-me`)
3. Enter account email
4. Click **Start OAuth**
5. Browser opens ChatGPT OAuth login
6. After login, copy the full redirected URL shown by the browser
7. Paste that URL in the dashboard and click **Complete OAuth from pasted URL**
8. Account appears with usage + controls

## Admin API (optional)

All admin routes require `x-admin-token` if `ADMIN_TOKEN` is set.

- `GET /admin/accounts`
- `POST /admin/accounts`
- `PATCH /admin/accounts/:id`
- `DELETE /admin/accounts/:id`
- `POST /admin/accounts/:id/unblock`
- `POST /admin/accounts/:id/refresh-usage`
- `POST /admin/usage/refresh`
- `POST /admin/oauth/start`
- `GET /admin/oauth/status/:flowId`
- `POST /admin/oauth/complete`

## Local dev

```bash
npm install
npm --prefix web install
npm run build
npm run start
```

## Notes

- OAuth endpoints/client can evolve. If OpenAI changes them, override env vars in `docker-compose.yml`.
- This project is for personal/self-hosted use.
