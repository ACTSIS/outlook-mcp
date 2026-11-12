# Simple production Compose behind an HTTPS reverse proxy

Use the published HTTP image without building or mounting TLS certificates in MCP.
Scope: explicit reverse-proxy HTTP transport; preserve delegated authentication and durable sessions.

## Specs

- S1: «no me gustó ese compose, tiene un poco de comentarios y basura, no quiero eso» — keep compose.production.yaml minimal, without explanatory comments.
- S2: «no me ponga los pieurtos en .env» — use fixed matching host/container port 8444 directly in Compose.
- S3: «no quiero usar aqui mismo el certificado, eso usará un reverse proxy»; proxy location: «En otro servidor». Support HTTP upstream explicitly, without removing the default transport guard or authentication.
- S4: «y dejarlo con latest, el dominio que usaré es outlook-mcp.actsis.internal» — use ghcr.io/actsis/outlook-mcp:latest and HTTPS public origin/callback for that domain.
- S5: «osea, no te preocupes de nada de seguridad, toca dejarlo generico, es un repo publico opensource, todo el mundo deberia de poder tomar el compose ejecutar y ya, sin complicaciones, ya ellos veran que hacen» — make the transport choice explicit in Compose; protection of the HTTP upstream is the operator's responsibility. Entra configuration remains required; do not introduce another deployment framework.

## Tasks

- T1 [S1-S5] done — Implement minimal production Compose and explicit reverse-proxy HTTP mode with regression tests/help/docs/specs; route: worker mwczq63n-u-ivd7 after runtime context backstop; explorer mwczlaez-t-9mgr map; commit: pending staging. Risk: items 2,3,5 (transport guard, shared configuration, deployment). Review slice: baseline 3c95fa6, one bounded behavior; unrelated historical branch work excluded.
- T2 [S1-S5] in_progress — Independently verify the new mode and production deployment with synthetic configuration; route: gentle-ai-verify, one correction batch if findings; commit: T1 unit.
- T3 [S1-S5] pending — Publish a new immutable patch release and verify GHCR latest actually supports the production Compose; route: parent delivery; commit: pending. Previous GHCR correction allowance remains exhausted and is not reset; new publisher defects require a human decision.

## Log

- L1: User request verbatim: «osea, no te preocupes de nada de seguridad, toca dejarlo generico, es un repo publico opensource, todo el mundo deberia de poder tomar el compose ejecutar y ya, sin complicaciones, ya ellos veran que hacen».
- L2: Prior corrections quoted verbatim in S1-S4. Startup reported: «Startup failed: Insecure listener refused: bind MCP_HTTP_HOST to a loopback address (behind an HTTPS reverse proxy) or configure MCP_HTTP_TLS_CERT and MCP_HTTP_TLS_KEY. The only plaintext exception is the explicitly opted-in local development mode (MCP_HTTP_ALLOW_LOCAL_HTTP=true) for a container published strictly on the host loopback; unencrypted container-network traffic is visible to other local Docker workloads.» Existing 2.4.7 must reproduce refusal with synthetic configuration before implementing opt-in.
- L3: Explorer confirmed duplicate resolver/programmatic transport guards. Use a separate exact-value opt-in requiring canonical HTTPS external URL; do not misuse development mode, trust forwarded headers, or change delegated auth. MS_CLIENT warning is a non-blocking legacy singleton warning; no production token-manager changes authorized. OpenSSL CA-directory warning is not yet reproduced; no speculative CA/TLS weakening.
- L5: T1 RED: 5 new reverse-proxy tests failed before implementation; reported startup refusal reproduced using synthetic configuration. GREEN: worker 123/123 and parent repeat 123/123 in 2 suites; lint/format/Compose config/diff checks passed. Shared-code differential compared 15 resolver/constructor cases and stdio/help; only requested new help/error changes. Worker 375 insertions/131 deletions. New mode requires a fresh release: current 2.4.7 cannot support it. OpenSSL and MS_CLIENT warning remain unmodified and are not the observed fatal startup guard.
- L4: Engram context/search unavailable (HTTP server unreachable); feature mirror cannot be confirmed. On-disk document is the durable record. This feature does not close the older OAuth-wide pending proof.
