# Embedded provider agent

The provider agent is a bounded Go component shipped with MultiVibe Core. Core supervises the packaged binary when `PROVIDER_AGENT_ENABLED=true`; no separate installer is supported.

This foundation exposes loopback health and a consent-bounded manifest containing only explicitly selected model identifiers. It enforces the ordered lifecycle `detected -> selected -> submitted -> approved -> online -> compensation-eligible`, with independent suspension and terminal revocation. It never scans LAN addresses, mDNS, processes, files, command lines, environment variables, or arbitrary ports.

An empty selection remains `detected`; only a non-empty, explicit selection is
reported as `selected`. Selected identifiers are unique, sorted and bounded to
100 entries, and URL-, IP- or filesystem-like values are rejected before they
can enter the consent manifest.

`GET /v1/adapters` exposes the bounded runtime contract embedded in the agent:
protocol, health and catalog paths, capabilities, authentication, measurement
dimensions, limits and reviewed automatic candidates. The registry covers the
full Core runtime list and keeps every adapter manual except the two literal
IPv4/IPv6 LM Studio loopback candidates. The agent itself refuses to listen on
anything other than literal `127.0.0.1` or `::1` port `1460`.

`GET /v1/detected-models` performs an on-demand local inventory through those
reviewed candidates only. Catalog calls are credential-free, redirect-free,
deadline- and size-bounded, and the response contains only the adapter ID and
validated model identifiers. Unavailable candidates expose no local error or
network details. The inventory remains local and does not select, enroll,
advertise or upload a model.

The live Cloud enrollment, dedicated-tailnet `tsnet` transport, mutually authenticated HTTP/2/WebSocket fallback, signed metering envelopes, and remote workload handling remain fail-closed until their credentials, protocol and Cloud gates are implemented and verified. The current binary does not enroll, advertise capacity, accept community work, or create compensation eligibility.

Core starts the embedded process with a closed environment allowlist containing
only its loopback URL, the agent loopback listen address and the explicitly
selected model identifiers. Provider credentials, Stripe or OAuth secrets,
control-plane tokens, API keys and unrelated parent-process variables are never
inherited by the agent.

Agent readiness calls Core's credential-free loopback `/health` endpoint. It
never receives or forwards the proxy API key merely to prove that the packaged
Core process is reachable.
