# Repository Instructions

These rules apply to `/Users/jorgitin/projects/multicodex-proxy`.

## Scope

- Keep changes surgical. Do not refactor unrelated routing, tracing, or dashboard code.
- Prefer targeted tests over broad rewrites.

## Proxy Behavior

- Do not add avoidable latency to proxied requests.
- Preserve fast-path behavior for successful requests.
- For routing changes, distinguish quota/rate-limit failures from transport timeouts and generic upstream errors.
- Do not retry another account after a proxy-side timeout unless the user explicitly asks for that tradeoff.

## Verification

- Reproduce proxy issues with traces or focused tests before changing behavior.
- For proxy/router fixes, add or update a targeted `node:test` case in `test/proxy-behavior.test.js` when practical.
- Run the narrowest relevant tests first, then broaden only if the change surface warrants it.

## Secrets And Data

- Treat files under `data/` as sensitive. Do not print or copy full tokens, refresh tokens, or account identifiers into responses.
