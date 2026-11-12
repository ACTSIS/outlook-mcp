# Authentication and token lifecycle

This guide describes the behavior implemented by the active dispatcher and executables: `bin/m365-mcp.js`, `index.js`, `outlook-auth-server.js`, and `auth/token-storage.js`. Microsoft Graph and Power Automate use separate OAuth grants but share one local token file.

## Authenticate successfully

1. Configure one Microsoft Entra app with the Web redirect URI `http://localhost:3333/auth/callback`.
2. Put `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, and `MS_TENANT_ID` in `.env`, or provide the `OUTLOOK_*` equivalents through the MCP client environment.
3. Call the `authenticate` MCP tool, copy the URL returned as the first response line, and open it in your browser. The browser is not opened automatically; the MCP process starts the callback server automatically.
4. After consent, call `check-auth-status` to validate the Graph token.
5. If Power Automate is required, call `authenticate-flow` and complete its separate consent flow.
6. When authentication is complete, call `stop-auth-server` to stop a server started by this MCP process.

`check-auth-status` is Graph-only. Validate Flow authentication with a Flow operation such as `flow-list-environments`.

Network and TLS errors now identify the operation and safe endpoint target. For example, `Microsoft Graph token exchange failed while connecting to https://login.microsoftonline.com/common/oauth2/v2.0/token: self-signed certificate in certificate chain (SELF_SIGNED_CERT_IN_CHAIN). Check network TLS trust/proxy configuration.` identifies the Microsoft token endpoint; it is not automatically a Vault failure. Query strings and credential values are omitted from the diagnostic.

## Vault setup lifecycle

When Vault mode is enabled, use the `setup-vault` MCP tool for the one-time OIDC browser setup. It saves only the Vault client token and lease metadata, loads the allowlisted Microsoft configuration into the current process, and returns status text without secrets.

Later OpenCode/MCP starts reuse the cache and never open a browser automatically. A missing, expired, or Vault-side unauthorized cache enters a setup-required state; call `setup-vault` explicitly instead. When `VAULT_TOKEN` is configured, it remains the explicit non-cached credential and bypasses OIDC. A permanent Microsoft Entra OAuth failure invalidates the matching Vault cache entry so setup can replace the identity in the same agent or after a restart. Vault network/timeout/503 errors, Vault lookup/KV 401/403 responses, user cancellation, Graph resource permission failures, and save/parse errors do not silently revoke the Vault cache. A sealed Vault (HTTP 503 with `Vault is sealed` in the response body) is reported as `VAULT_SEALED` instead of a generic HTTP error: no auth method, cached token, or `VAULT_TOKEN` can work until a Vault operator runs `vault operator unseal`; the local cache is preserved and startup can be retried afterwards.
If the Vault browser cannot be opened, the complete short-lived authorization URL is copied to the system clipboard and printed for manual use. Clipboard support is best-effort and does not fail the Vault setup itself.

The repository-level manual setup command is:

```powershell
node bin/m365-mcp.js vault-setup
npm run vault-setup
```

For a packaged Windows executable, run `outlook-mcp-win-x64.exe vault-setup`. The dispatcher loads the external `.env`, performs the existing browser/manual flow, persists the Vault identity cache, applies allowlisted values, and emits only safe status. It exits `0` on success, `1` on setup/runtime failure, and `2` when Vault is disabled or misconfigured. `opencode mcp auth <name>` is not a substitute: current OpenCode documentation describes that command for remote OAuth MCP servers, while a local stdio MCP entry cannot use it to invoke this repository subcommand. `m365-mcp-auth` remains the separate Microsoft callback-server entry point.

When Vault is expected to supply Microsoft OAuth values, remove the corresponding `MS_*`/`OUTLOOK_*` OAuth keys from the MCP client's environment. Process/MCP values intentionally take precedence over Vault, so leaving those keys in the environment prevents Vault from supplying them.

## TLS certificate trust

Productive HTTPS clients merge Node's bundled public CA roots with the current Windows/system certificate store through the Node 22.22.1 TLS certificate APIs. TLS verification remains enabled. A customer does not need to export/import a PEM file or set `NODE_EXTRA_CA_CERTS` for a CA already installed in the system store. Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0` or `rejectUnauthorized: false`.

## OAuth grants and scopes

The active auth server uses the Microsoft identity platform v2 authorization-code grant.

Graph initial acquisition requests the configured built-in delegated scope union:

```text
offline_access User.Read Mail.Read Mail.ReadWrite Mail.Send
Mail.Send.Shared Mail.ReadWrite.Shared
Calendars.Read Calendars.ReadWrite Calendars.Read.Shared
Contacts.Read Files.Read Files.ReadWrite Sites.Read.All
```

`offline_access` is required for Microsoft to issue a refresh token. Power Automate uses a separate authorization and token exchange with `config.FLOW_SCOPE`, which combines `offline_access` with the Flow resource scope — without `offline_access` the Flow token exchange returns no refresh token and `authenticate-flow` must be repeated at every expiry:

```text
offline_access https://service.flow.microsoft.com/.default
```

The active callback server creates a random 32-byte state value, keeps it in memory for up to ten minutes, records whether it belongs to Graph or Flow, and consumes it once at callback. Restarting the auth server invalidates outstanding states.

### Per-user shared-mailbox enforcement

The delegated `.Shared` scopes (`Mail.Send.Shared`, `Mail.ReadWrite.Shared`, `Calendars.Read.Shared`)
enable acting on mailboxes other than the signed-in user, but they authorize **nobody by default**.
Whether a given user may send or draft in a shared mailbox is decided by Exchange delegation on that
mailbox — Send As, Send on Behalf, or Full Access granted to that user by the mailbox owner or an
Exchange administrator — not by the MCP or the app registration.

This is delegated authorization only: no client-credentials flow, no app-only policy, no bypass of
the per-user right. The optional `from` parameter of `send-email`, `draft-email`, and `forward-draft`
targets `users/{from}/...` Graph endpoints; a caller lacking the delegation gets Graph HTTP 403,
which the email tools surface as a `MAILBOX_ACCESS_DENIED` failure naming the mailbox and the
missing delegation. There is never a silent fallback to the caller's own mailbox.

### SharePoint site tools: delegated read only

The `sites/` tools (`list-sites`, `list-site-files`, `download-site-file`) use the delegated
`Sites.Read.All` scope inside the same authorization-code flow, and SharePoint itself enforces
per-user access to each site collection: the scope grants no site that your account cannot read.
Graph HTTP 403 there surfaces as `SITE_ACCESS_DENIED` naming the site, with no fallback identity.
No client-credentials flow and no application permission is used for SharePoint: that capability
is deferred in issue #18 until an unattended use case justifies global-admin consent, a
certificate credential, and an Application Access Policy. If `MS_SCOPES` overrides the scope
union, it MUST include `Sites.Read.All` explicitly, or the site tools fail consent errors.

## Storage contract

The default token store is:

```text
~/.outlook-mcp-tokens.json
```

Writes request filesystem mode `0600` (owner read/write). Protect this file as a credential: never commit, copy into logs, or share it.

The JSON may contain Microsoft response fields plus the derived expiry fields below:

| Token family | Fields used by the runtime                                                         |
| ------------ | ---------------------------------------------------------------------------------- |
| Graph        | `access_token`, `refresh_token`, `expires_in`, `expires_at`, `scope`, `token_type` |
| Flow         | `flow_access_token`, `flow_refresh_token`, `flow_expires_at`                       |

Both families live at the top level of the same object. `saveFlowTokens()` merges `flow_*` values into existing Graph data. By contrast, active Graph initial acquisition currently raw-writes the Graph response; see [Known limitations](#known-limitations).

## Runtime lifecycle

### Graph

1. A Graph-backed handler calls `ensureAuthenticated()`.
2. The singleton `TokenStorage` loads the token file once on demand; concurrent first loads share `_loadPromise`.
3. If `access_token` is absent, the handler receives `Authentication required`.
4. If the token is valid beyond the five-minute buffer, it is returned.
5. If the token is expired or within five minutes of `expires_at`, `refreshAccessToken()` uses the refresh-token grant.
6. Concurrent Graph refresh callers share `_refreshPromise`.
7. A successful response replaces the access token and expiry. A returned rotated `refresh_token` replaces the old one; if Microsoft omits it, the old refresh token remains.
8. Updated tokens are written back to the shared file.

### Power Automate

1. Every Flow handler calls `getValidFlowAccessToken()`.
2. A valid `flow_access_token` is returned immediately.
3. An expired/near-expiry Flow token is refreshed **only if `flow_refresh_token` exists**.
4. Concurrent Flow refresh callers share `_flowRefreshPromise`.
5. Successful refresh updates `flow_access_token` and `flow_expires_at`; refresh-token rotation is handled when present and the old value is otherwise preserved.
6. A permanent OAuth `invalid_grant` clears only `flow_access_token` and `flow_refresh_token`, preserving Graph fields.
7. Network, timeout, and other transient Flow refresh errors return no usable token for that call but do not deliberately invalidate stored Flow credentials.

Auto-refresh cannot create an initial Flow grant. If the file has no Flow access token, or an expired Flow token has no refresh token, complete `authenticate-flow`.

## Refresh failure matrix

This table documents current behavior, including asymmetry rather than an idealized policy.

| Path and failure                                       | Classification            | Current in-memory result                                                                                               | Current disk result                                                                                 | Recovery                                                                                             |
| ------------------------------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Flow refresh HTTP 400 `invalid_grant`                  | Permanent                 | Clears Flow access/refresh only; Graph remains                                                                         | Persists cleared `flow_*` values                                                                    | Run `authenticate-flow`                                                                              |
| Flow refresh network/timeout/non-`invalid_grant` error | Transient or unknown      | Keeps token object; current call returns no token                                                                      | Stored token object is kept                                                                         | Retry; reauthenticate Flow only if the error persists                                                |
| Flow token expired with no Flow refresh token          | Missing credential        | Keeps existing token object; returns no token                                                                          | Unchanged                                                                                           | Run `authenticate-flow`                                                                              |
| Graph refresh permanent Entra OAuth rejection          | Permanent                 | Sets the entire in-memory token object to `null`, affecting Graph and Flow                                             | The matching Vault identity cache is invalidated; the shared Microsoft token file remains unchanged | Call `setup-vault`, then complete Graph auth if needed                                               |
| Graph refresh network/timeout/parse/save error         | Transient or local        | Sets the entire in-memory token object to `null` for the current call path; no Vault cache invalidation                | The shared Microsoft token file remains unchanged                                                   | Retry after the dependency recovers; call `setup-vault` only for a confirmed permanent Entra failure |
| Graph token expired with no refresh token              | Missing credential        | Same whole-object in-memory clear                                                                                      | Same no-op disk invalidation                                                                        | Complete Graph auth, then verify Flow                                                                |
| Successful refresh but token-file save fails           | Local persistence failure | Refresh methods update memory before rejecting; Graph caller then clears all memory, while Flow keeps its token object | Old file content remains                                                                            | Fix file/home permissions and retry authentication                                                   |

## Configuration and precedence

The runtime, callback server, and `TokenStorage` resolve `OUTLOOK_CLIENT_ID` before `MS_CLIENT_ID`, and `OUTLOOK_CLIENT_SECRET` before `MS_CLIENT_SECRET`. They also honor `MS_TENANT_ID`, `MS_AUTHORITY_HOST`, `MS_SCOPES`, `MS_REDIRECT_URI`, and `MS_TOKEN_ENDPOINT` for active acquisition and refresh/exchange operations.

The active initial-acquisition server obtains redirect URI and Graph scopes from `config.js` and constructs its own token endpoint. Therefore the three `TokenStorage` overrides are not a consistent end-to-end customization mechanism; see limitation 5 below.

## Remote MCP HTTP mode (delegated Entra identity)

`m365-mcp http` runs the MCP server as an authenticated intranet HTTP listener (`remote/http-server.js`). It keeps the local stdio deployment untouched and does not read the shared local token file; see [the README](../README.md#intranet-mcp-http-mode-entra-delegated-identity) for setup.

The authentication mode is selected explicitly with `MCP_HTTP_AUTH_MODE=entra|bridge`: **direct Entra mode (optional, unchanged)** exposes only the tenant Entra issuer in discovery, with fully resource-qualified request scopes (the T12 `api://<client id>/<short scope>` derivation, or exactly `MCP_HTTP_UPSTREAM_SCOPES`) in `scopes_supported` and the `WWW-Authenticate` `scope` attribute, while token verification keeps requiring the short scp scope names; standards MCP clients authorize directly with Entra and keep their own refresh tokens client-side. **Bridge mode (the chosen, persistent flow)** is the service-owned standards OAuth sign-in flow: the upstream sign-in now also requests `offline_access`, the service holds each family's upstream refresh credential server-side, renews the upstream access token through the tenant-pinned refresh grant (`remote/entra-refresh.js`), re-verifies every renewed credential with the same deployment verifier and the immutable delegated `oid`/`tid`, commits renewed or rotated credentials into the encrypted durable store, and permanently invalidates only the affected family on a genuinely unusable upstream credential (Microsoft's own reauth conditions), never on client/configuration errors or transient outages (`/mcp` answers `503 temporarily_unavailable` while renewal is briefly unavailable). No per-agent Entra application registration is required for the bridge. Without the selector, the known behavior is preserved: bridge iff `MCP_HTTP_LOGIN_REDIRECT_URI` is set, direct Entra otherwise; explicit entra ignores the bridge-only settings and still enforces every shared audience/tenant/scope validation, and explicit bridge requires the complete bridge configuration. The RFC 9728 `resource` value stays the deployment's canonical base URL in both modes — it is never rewritten into an `api://` URI, and whether live Entra tenants accept the standards clients' RFC 8707 `resource` parameter (this base URL) against a non-Application-ID-URI resource is **unverified**; the server implements the standards seam faithfully and must not mask that question. Security-relevant behavior:

- The listener verifies a Microsoft Entra **delegated** access token per request (`remote/entra-auth.js`): RS256 signature against the tenant JWKS, issuer `https://login.microsoftonline.com/{tenant}/v2.0`, the configured audience for this deployment, tenant match, a finite expiry, a user identity claim, and the non-empty delegated scope configured through `MCP_HTTP_REQUIRED_SCOPES`. With the Entra v2.0 endpoint the access token's `aud` is the API application's client ID GUID and `scp` carries short scope names, so the audience **defaults to `ENTRA_CLIENT_ID`** and the required scope **defaults to `mcp.access`** (or to the short scope part of an explicitly configured `MCP_HTTP_UPSTREAM_SCOPES`); `MCP_HTTP_AUDIENCE` and `MCP_HTTP_REQUIRED_SCOPES` remain optional overrides with unchanged validation (API-qualified `api://…` URIs are still refused in `MCP_HTTP_REQUIRED_SCOPES`). The resource-qualified `api://<app-id>/<scope>` authorization-request scope (`MCP_HTTP_UPSTREAM_SCOPES`) derives to `api://<client id>/<required short scope>` when omitted; only that shape is ever derived, so when the app's Application ID URI differs from `api://<client id>` the administrator must set `MCP_HTTP_UPSTREAM_SCOPES` explicitly.
- Before dispatch, the verified token is exchanged (OAuth on-behalf-of, `remote/obo-token-store.js`) for that user's Graph and Power Automate tokens. There is **no local credential fallback**: the local token file, Vault cache, and legacy token manager are never consulted by a remote request, and the local `authenticate`/`setup-vault`/`check-auth-status`/`authenticate-flow`/`stop-auth-server`/`about` tools are not listed and not callable remotely.
- Every verified authenticated identity runs the same tool set; there is no separate MCP mutation gate, read-only allowlist, or mutation-group configuration. Authorization beyond delegated authentication is owned by the Entra enterprise-application assignment (which controls who can obtain a token for this API) and each user's own Microsoft 365 permissions behind the on-behalf-of exchange: a Microsoft 365 denial (for example a public Graph `403`) surfaces to the client unchanged.
- The listener refuses to start when `USE_TEST_MODE=true`, when required configuration is missing, when binding a non-loopback address without TLS, or when binding a wildcard address (`0.0.0.0`, `::`) without an explicit `MCP_HTTP_EXTERNAL_BASE_URL`: a wildcard bind has no usable listener-derived discovery URL. Behind a reverse proxy that terminates HTTPS, keep the listener loopback-bound, or opt in to the dedicated reverse-proxy transport below.
- Unauthenticated requests receive `401` with RFC 9728 `WWW-Authenticate` metadata pointing at `/.well-known/oauth-protected-resource`. In direct Entra mode the challenge additionally names the fully resource-qualified request `scope` list (the same entries as `scopes_supported`), and discovery advertises the Entra issuer as the only authorization server; the legacy bridge challenge and its merged service-OAuth metadata stay unchanged for existing clients. Discovery and challenge URLs are derived from trusted configuration only (`MCP_HTTP_EXTERNAL_BASE_URL`, or the validated listener host/port); the untrusted request `Host` header is never reflected, and bearer credentials must be exactly one RFC 7230 token: trailing parts, junk characters, and wrong schemes are rejected as absent. Verification is stateless per process: the same still-valid synthetic bearer token is accepted again by a recreated server, and no client-credential renewal subsystem exists in the server (agents own their Entra refresh tokens).
- Tokens, client secrets, and user identities never appear in error responses or logs.
- When the standards MCP OAuth login flow is configured (see the README), the service is additionally its own authorization server for pre-registered external MCP clients (`remote/oauth-provider.js` + `remote/entra-login.js`): unregistered clients and redirects are refused at `/authorize`, S256 PKCE is mandatory, authorization codes are single-use and bound to client, exact redirect, scope, resource, and user, the browser returns only code and state to the exact registered client redirect, and the `/token` response carries the MCP-scoped rotating access/refresh token pair (one-time refresh rotation per family; no ID token and no upstream Entra token ever leaves the server). The service consent page (`remote/login-page.js`) names the client, its exact registered redirect, and the requested permissions, is CSRF-protected, refuses framing, contains no scripts and mimics no Microsoft sign-in UI. Every browser submission passes the strict origin gate, and the page serves `strict-origin` so a real browser sends its exact true `Origin` on the same-origin consent POST (under `no-referrer`, Chromium/Edge/Chrome submit the form with `Origin: null`, which the gate must keep refusing) while the `Referer` is reduced to the bare origin — at most the origin, never the referral URL whose query carries the OAuth authorization reference, cross-site or same-origin. The consent page and its redirect carry a CSP `form-action` allowlist of exactly `'self'` plus the server-trusted configured Entra authorization origin (T11, S8): Chromium re-checks the initiating document's `form-action` across every hop of a form navigation, so a `'self'`-only policy blocked the real-browser redirect to Microsoft's authorization endpoint and left the user stranded on a page whose repeated consent click then failed closed against the already-consumed one-time CSRF token (`csrf-failed`, with recovery guidance instead of unsafe replays; re-opening the sign-in page issues a fresh one-time CSRF). No registered client redirect and no unregistered or request-controlled origin is ever a form-action target, the referrer policy stays unchanged, and framing, script, and sniffing protections are identical on every page. Microsoft's own flow validates `state`, `nonce`, signature, issuer, audience, expiry, tenant, and identity; the consent of one browser session never authorizes another client. Before the MCP authorization binds, the upstream access token Entra returned together with the ID token is re-verified against this deployment (signature, issuer, configured API audience, tenant, expiry, short scp scope names, and the same user object ID as the ID token): an upstream token that does not validate is never bound and never reaches the on-behalf-of exchange. When the retained upstream Entra token nears expiry, the bridge renews it server-side from the stored upstream refresh credential (per family under a singleflight, commit before observable); while that renewal is transiently failing, `/mcp` answers `503 temporarily_unavailable` and never dispatches a tool or falls back to another credential; when the upstream credential is unusable (Microsoft's reauth conditions, or a renewed credential that fails this deployment's verifier or the immutable `oid`/`tid` binding), `/mcp` refuses with `401` and the family is permanently invalidated, so the user signs in again.

### Entra application registration checklist for the HTTP mode

- In direct Entra mode (optional, unchanged), agents additionally need a separate **public client** application registration ("Allow public client flows": yes, no client secret): a Desktop/native redirect URI exactly matching the client's real loopback callback (Pi 1.5.2 sends `http://127.0.0.1:<port>/callback`; register the exact URI — do not substitute `localhost`), and the agent's requested scopes must include `offline_access` plus the resource-qualified API scope so Entra issues a refresh token that only the client holds. See the README for the verified Pi settings and the documented unverified interoperability question (the RFC 8707 `resource` value against a live tenant).
- Use one confidential app registration per tenant for the MCP service: register the **exact** browser callback `https://<your-host>/login/callback` (Web platform) as the service's sign-in redirect URI when the persistent bridge flow is enabled (for the explicitly local development run with `compose.local.yaml`, also register the loopback HTTP callback `http://localhost:8443/login/callback`; Microsoft permits plain HTTP redirect URIs only for loopback addresses), and expose the delegation API scope (`mcp.access` on the app that owns `ENTRA_CLIENT_ID`, or `api://<app>/<scope>` under a different Application ID URI). No audience/scope variables are needed for the standard `api://<client id>` shape: the audience derives to the client ID GUID, the required scope to `mcp.access`, and the upstream request scope to `api://<client id>/mcp.access`. When the Application ID URI or token audience differs, set `MCP_HTTP_UPSTREAM_SCOPES` (and `MCP_HTTP_AUDIENCE` for a non-GUID `aud`) explicitly; the overrides' validation is unchanged.
- Keep the client secret only in the runtime environment (`.env.docker` for Compose, Vault or process environment locally); never in docs, client configuration, or the browser-visible flow.
- Register each external MCP client with its exact redirect URI in `MCP_HTTP_OAUTH_CLIENTS` (or explicitly enable dynamic registration); external clients never need, receive, or possess Entra credentials.
- Do not configure MCP-side mutation authorization: none exists by design. Whoever can obtain a delegated token for this API (enterprise-application assignment) may run the tools, and Microsoft 365 still enforces each user's own permissions behind the on-behalf-of exchange.
- The OAuth login-flow behavior above is covered by offline tests with synthetic keys only; it has not been tested against an actual tenant.

### Docker deployment and secret handling

The containerized deployment (`compose.yaml` at the repository root) terminates TLS inside the MCP container and publishes to the host loopback by default; see [README](../README.md#docker-compose-direct-tls-listener-in-the-container). Secret handling:

- **Reverse-proxy production (`compose.production.yaml`):** the generic, minimal public-repo config runs the published `ghcr.io/actsis/outlook-mcp:latest` image as **plain HTTP** on the fixed `8444:8444` mapping under the explicit `MCP_HTTP_REVERSE_PROXY_HTTP=true` opt-in (any other value refuses startup), which requires the canonical `https://` `MCP_HTTP_EXTERNAL_BASE_URL` and never trusts the proxy's forwarded Host/proto headers. Your external HTTPS reverse proxy — typically on **another server** — terminates client TLS and forwards to `http://<this-server>:8444`; protection of that plaintext upstream hop is the operator's responsibility, explicitly accepted via the flag. The config overrides `MCP_HTTP_TLS_CERT`/`MCP_HTTP_TLS_KEY` to empty strings so a stale runtime secret can never enable TLS, forces `MCP_HTTP_AUTH_MODE=bridge` with the public origin and its exact `https://outlook-mcp.actsis.internal/login/callback` Web redirect, and keeps the same durable bridge volume, hardened posture, and single replica. Runtime Entra configuration stays in `.env.docker`.

- **Local development only:** `compose.local.yaml` runs the same container without TLS under the explicit `MCP_HTTP_ALLOW_LOCAL_HTTP=true` opt-in, hard-pins the published host port to `127.0.0.1`, and has no TLS mount at all. It applies its own plaintext loopback overrides (`MCP_HTTP_EXTERNAL_BASE_URL=http://localhost:8443`, `MCP_HTTP_LOGIN_REDIRECT_URI=http://localhost:8443/login/callback`) on top of the same `.env.docker`, so an existing production-shaped runtime file works unchanged. Traffic inside the local Docker bridge network is unencrypted and may be visible to other local Docker workloads; the mode is explicitly not for intranet or production use.

- Entra tenant, client credentials, and the required externally reachable `MCP_HTTP_EXTERNAL_BASE_URL` reach the container only through the runtime-ignored `.env.docker` file (a documented dummy sample ships as `docker-env.example`; the token audience and delegated scope derive from the client ID v2 defaults, with the documented audience/scope overrides optional). It is git-ignored and docker-ignored, never baked into the image, and never logged.
- The `.dockerignore` whitelist keeps node_modules, `.git`, `.env*`, tokens, and PEM keys out of the build context entirely.
- The image runs as the unprivileged `node` user (uid 1000) with a read-only root filesystem; the TLS PEMs come from a read-only volume mount and must be readable by uid 1000 at startup, otherwise the listener fails closed with a configuration error.
- The same live-verification caveat as above applies: the Compose deployment has been proven only with generated self-signed test certificates and fake Entra values, never against a real tenant.

## Known limitations

These are verified implementation limitations, not promised fixes:

0. **Flow credentials acquired before the `offline_access` scope still lack a refresh token.** `config.FLOW_SCOPE` now requests `offline_access`, so fresh `authenticate-flow` grants receive a refresh token and auto-refresh works. Tokens acquired under the older scope (without `offline_access`) hold only `flow_access_token` + `flow_expires_at`; when they expire, run the Flow acquisition once more to pick up a refresh-capable grant.

1. **Graph token invalidation is not persisted.** On a Graph refresh failure or an expired Graph token without a refresh token, `getValidAccessToken()` sets `this.tokens = null` and then calls `_saveTokensToFile()`. That save is a no-op when `this.tokens` is null, so stale Microsoft credentials survive on disk and can be loaded after restart. A confirmed permanent Entra failure separately invalidates the Vault identity cache.
2. **Graph reauthentication can erase Flow credentials.** Active Graph initial acquisition in `outlook-auth-server.js` raw-writes the shared token file instead of merging with existing data. Existing `flow_*` fields are removed. Complete `authenticate-flow` again after Graph reauthentication when needed.
3. **Graph refresh in-memory clearing remains broad.** Graph now distinguishes permanent Entra OAuth rejection from transient network, timeout, response-parsing, and save errors for Vault-cache invalidation, but every refresh failure still clears the whole token object in memory, including Flow fields.
4. **Flow test authentication is incomplete.** With `USE_TEST_MODE=true`, `authenticate-flow` reports success but calls the legacy `createTestTokens()`, which writes only Graph-shaped keys. Flow handlers still find no `flow_access_token` unless their token dependency is mocked or a suitable token file already exists.

Additional interface asymmetries:

- `authenticate` advertises a `force` input, but its handler ignores it and only returns an auth URL.
- `check-auth-status` checks Graph only; it does not report Flow state.
- There is no public MCP logout tool. `TokenStorage.clearTokens()` exists internally and deletes the shared file, but no tool invokes it.
- `auth/oauth-server.js` is an inactive Express-oriented implementation covered by direct unit tests. Neither `index.js` nor `outlook-auth-server.js` uses it; do not infer production routes or configuration from it.
- The remote MCP HTTP mode has not been validated against a real Entra tenant or a real Power Automate backend yet; the OBO exchange and Flow compatibility are covered only by offline, mocked-HTTP tests (see limitation 4 for the separate stdio test-mode asymmetry). The standards OAuth login flow for external MCP clients is likewise proven only by offline tests with synthetic keys, a mocked Microsoft token endpoint, and mock Graph calls; an independent security proof was not produced for this slice.

## Test-mode boundary

`USE_TEST_MODE=true` changes Graph and Flow API clients to return mock responses when they receive recognized test-token prefixes. It does not faithfully simulate the two-token OAuth lifecycle. In particular, the shared legacy authentication helper creates only a Graph access token. Use focused unit tests with a mocked `TokenStorage` when validating Flow handler authentication behavior. The remote MCP HTTP mode never starts under test mode: combining `USE_TEST_MODE=true` with an HTTP listener is refused at startup.

## Recovery without unnecessary data loss

- For a Graph-only problem, start with `check-auth-status`, then complete `authenticate` if needed.
- For a Flow-only problem, call `flow-list-environments`, then complete `authenticate-flow` if needed.
- After Graph reauthentication, verify Flow separately because the shared-file overwrite can remove Flow fields.
- Delete `~/.outlook-mcp-tokens.json` only when intentionally resetting **both** Graph and Flow. The server has no selective public logout.
- For HTTP 401, reauthenticate the corresponding token family; API 401 responses do not force local token invalidation. For HTTP 403, verify permissions, consent, ownership, and resource eligibility; repeating authentication alone may not fix authorization. When acting on a shared mailbox (`from` parameter), a 403 usually means the Exchange Send As / Full Access delegation is missing — surface it as `MAILBOX_ACCESS_DENIED` — and an administrator must grant the delegation rather than the user re-authenticating.
