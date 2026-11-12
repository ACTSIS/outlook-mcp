# URL-only Pi configuration through dynamic client registration

Enable automatic OAuth client registration in the existing ACT-TWC-11 deployment.
Preserve Microsoft sign-in, renewable sessions, and existing manually registered clients.

## Specs

- S1: «no entiendo, es necesario el clienteid el callbackport y el scope? no entiendo, no me gusta eso» — let Pi configure this MCP with only its URL, without manual clientId, callbackPort, or scope.
- S2: User accepted «si porfa» to «¿Habilito el registro automático para dejarlo así de simple?» — enable existing dynamic registration on ACT-TWC-11:/home/ubuntu/docker/outlook-mcp; preserve Microsoft login and existing settings/data.
- S3: Accepted proposal: «Después: /mcp login outlook. Microsoft seguirá solicitando iniciar sesión; no se elimina la autenticación.» — registration alone must not grant access to MCP or Microsoft data.

## Tasks

- T1 [S1-S3] done — Reproduce installed Pi DCR payload rejection and add bounded support for authorization_code + refresh_token registration/persistence/renewal; preserve authorization-code-only and unsupported-grant behavior; tests/docs/spec. Route: worker mwd1fvlp-y-iop3 after context backstop; explorer mwd1ckp7-x-odx1. Commit: pending staging. Risk: item 2 (OAuth client registration/grants), item 3 (shared provider behavior). Baseline79a9fa6; review only this bounded unit, not historical branch.
- T2 [S1-S3] in_progress — Independently verify actual installed Pi request and public register/authorize/token flows on isolated synthetic state; route: gentle-ai-verify. Commit: T1 unit. Risk: item 2.
- T3 [S1-S3] pending — Publish a new immutable patch if necessary, enable DCR in remote Compose with validated config backup and same volume, verify endpoint advertised and unauthenticated MCP remains401; give URL-only config. Route: parent release/SSH. Commit: pending. Risk: items 2,5. Publisher correction budget remains zero; do not modify/retry failed publisher without authorization.

## Log

- L1: User request verbatim: «si porfa».
- L2: Immediately preceding accepted proposal verbatim: «¿Habilito el registro automático para dejarlo así de simple?» with URL-only mcp.json and /mcp login outlook, Microsoft authentication retained. User's concern quoted verbatim in S1. Target host/path already explicitly authorized; no reading real .env*/tokens/keys.
- L3: Live metadata before change: issuer=https://outlook-mcp.actsis.internal, scopes_supported=[mcp], registration_endpoint absent. No remote writes yet. Existing MCP_HTTP_OAUTH_ALLOW_DYNAMIC_REGISTRATION flag maps into optional /register; it defaults off.
- L4: Explorer mwd1ckp7-x-odx1 read installed Pi1.5.2 pi-mcp/dist/oauth/provider.js:23-31 and flow.js:137-161: Pi sends grant_types=[authorization_code,refresh_token], response_types=[code], token_endpoint_auth_method=none, native loopback redirect. Provider remote/oauth-provider.js:550-555 rejects refresh_token and stores only authorization_code (:578), so merely toggling flag would fail and omit renewable tokens. Existing refresh-mint/storage validation already supports dual grants; no schema migration expected. Reproduce before fix and use the real installed request shape in regression.
- L6: Worker RED3 reproduced Pi registration400 and persistence rejection; GREEN122/122 in three suites. Parent repeated122/122 (10.664s), lint/format/diff pass. Initial worker format check flagged only parent-owned unformatted task doc; parent formatted it and full format passed. Narrow helper used only DCR registration/persisted-client validation; existing manually configured client validation/issuance untouched. Accepted grants preserved, code-only remains nonrenewable, unsupported/refresh-only rejected, dual-grant synthetic flow+restart renewal verified. Diff214insertions/19deletions plus task doc; no deployed changes yet.
- L5: Engram unavailable earlier this session; no memory mirror confirmed. Existing OAuth-wide pending review is separate; this unit verifies only DCR compatibility. Existing source/remote2.4.8 remain untouched until correction validated. No changes to Entra application registrations or Pi installation are authorized/needed.
