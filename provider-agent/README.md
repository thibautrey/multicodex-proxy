# Embedded provider agent

The provider agent is a bounded Go component shipped with MultiVibe Core. Core supervises the packaged binary when `PROVIDER_AGENT_ENABLED=true`; no separate installer is supported.

This foundation exposes loopback health and a consent-bounded manifest containing only explicitly selected model identifiers. It enforces the ordered lifecycle `detected -> selected -> submitted -> approved -> online -> compensation-eligible`, with independent suspension and terminal revocation. It never scans LAN addresses, mDNS, processes, files, command lines, environment variables, or arbitrary ports.

The live Cloud enrollment, dedicated-tailnet `tsnet` transport, mutually authenticated HTTP/2/WebSocket fallback, signed metering envelopes, and remote workload handling remain fail-closed until their credentials, protocol and Cloud gates are implemented and verified. The current binary does not enroll, advertise capacity, accept community work, or create compensation eligibility.
