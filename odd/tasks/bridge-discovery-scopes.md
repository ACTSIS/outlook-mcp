# Consistent Outlook bridge OAuth discovery scopes

Fix LibreChat's invalid_scope caused by Outlook resource metadata mixing Entra and bridge scope namespaces.
Scope is the Outlook MCP only; no changes to LibreChat, its other MCPs, SSO, or Entra configuration.

## Specs

- S1: «si porfis, que no me impacte otros mcps que tenga alli» — authorize the scoped Outlook correction without affecting other MCP servers configured in LibreChat.
- S2: Accepted proposal: «¿Corrijo los metadatos del MCP para que funcione automáticamente con tu YAML actual, sin añadir campos OAuth ni tocar Entra?» — bridge protected-resource discovery must advertise the scopes supported by its advertised first bridge authorization server, without downstream Entra API scope leakage.
- S3: Reported failure: «en librechat no funcionó»; «lo que hace es salir un error y me abre otra pestaña con chat.actsis.com». Logs: «Authentication failed invalid_scope». The existing LibreChat YAML should reach Microsoft login without a manual oauth.scope override; this does not authorize completing user consent.

## Tasks

- T1 [S1-S3] done — Correct only bridge protected-resource scopes and pin metadata-driven authorize flow; preserve direct Entra, raw delegated-token validation, authorization_servers ordering, scopes validation, and all other MCP configurations. Route: worker mwdmgz46-12-36b8 (context backstop); exploration mwdlrz8b-11-8sd2. Commit: pending staging. Risk: items 2,3 (OAuth discovery contract/shared helper). Baseline7de5780; one bounded review slice distinct from historical branch.
- T2 [S1-S3] in_progress — Independently verify metadata coherence and the LibreChat scope-selection flow with isolated synthetic state; verify direct-mode and raw-token preservation. Route: gentle-ai-verify, one correction batch if blockers. Commit: T1 unit. Risk: items 2,3.
- T3 [S1-S3] pending — Publish a new immutable patch, update only ACT-TWC-11 outlook-mcp service preserving config/volume/ports, verify public discovery from existing LibreChat container. Route: parent release/SSH. Commit: pending. Risk: items 2,5. No LibreChat configuration edit/restart or other MCP changes. Existing publisher correction budget stays zero; no retries or tag rewrites.

## Log

- L1: User request verbatim: «si porfis, que no me impacte otros mcps que tenga alli».
- L2: Public live evidence from actual LibreChat container: protected-resource scopes_supported=[user_impersonation,mcp], first bridge AS scopes_supported=[mcp]. Source remote/http-server.js:1864 unions requiredScopes and oauth.supportedScopes; remote/oauth-provider.js:1325 rejects scopes outside bridge supported set. Public LibreChat MCP OAuth handler selects PR scopes before AS scopes. No authorization URLs, states, real tokens, private keys, or env contents were read.
- L3: Parent isolated public-router reproduction (no real users/clients/files): /authorize with synthetic registered client and scope='user_impersonation mcp'→302 callback error=invalid_scope; same request with scope='mcp'→302 /login without error. Direct cause proven; unrelated GitHubSkillSync401/scheduler messages are out of scope.
- L4: Change only bridge PR scopes to match the actual effective bridge AS scopes (including defaults), not authorization_servers ordering and not scope acceptance. Do not implement the explore suggestion of accepting upstream scopes at the bridge AS: keep the authorization boundary and issuer namespaces separate. Direct Entra discovery and raw JWT validation remain unchanged. No LibreChat, SAML, OIDC, scheduler, GitHub sync, or other MCP changes are authorized.
- L6: Worker RED1 observed PR scopes[mcp.access,mcp] vs AS[mcp]; GREEN111/111 two focused suites, parent repeat111/1116.969s, lint/format/diff pass (parent formatted its own task doc). Source delta101insertions/15deletions incltests/docs. Effective bridge ASmetadata reused, not guessed rawscopes. Differential41fields againstbaseline7de5780: only intended bridge scopes and resulting PR-driven authorize route/error changed; direct-mode PRM/AS404/challenge, ASordering/resource/bearer-methods, upstream/unknownscope rejection unchanged. No source/Compose/LibreChat/Entra/otherMCP modifications outside allowedserver/docs/tests.
- L5: Engram search unavailable this session (HTTP server unreachable); no memory mirror confirmed. Previous DCR failed verifier and later successful bounded continuation remain in odd/tasks/pi-dynamic-registration.md; no limits or historical outcomes reset.
