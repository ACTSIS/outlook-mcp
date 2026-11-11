# M365 Assistant MCP Server

[![CI](https://github.com/rafaga2469/outlook-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rafaga2469/outlook-mcp/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Frafaga2469%2Foutlook-mcp%2Fbadges%2Fcoverage.json)](https://github.com/rafaga2469/outlook-mcp/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Frafaga2469%2Foutlook-mcp%2Fbadges%2Ftests.json)](https://github.com/rafaga2469/outlook-mcp/actions/workflows/ci.yml)

An independently maintained fork of [ryaker/outlook-mcp](https://github.com/ryaker/outlook-mcp). It exposes 52 MCP tools for Outlook mail and calendar, Teams chats, OneDrive, SharePoint sites, inbox rules, and Power Automate.

## Quick start

You need Node.js 22.22.1 or later and a Microsoft Entra app registration.

1. Install the server:

   ```bash
   git clone https://github.com/rafaga2469/outlook-mcp.git
   cd outlook-mcp
   npm install
   cp .env.example .env
   ```

2. Register a Web redirect URI of `http://localhost:3333/auth/callback` in Microsoft Entra ID and add these delegated Microsoft Graph permissions:

   ```text
   offline_access User.Read Mail.Read Mail.ReadWrite Mail.Send
   Mail.Send.Shared Mail.ReadWrite.Shared
   Chat.ReadWrite Calendars.Read Calendars.ReadWrite Calendars.Read.Shared
   Contacts.Read Files.Read Files.ReadWrite Sites.Read.All
   ```

   The Teams chat tools (`list-chats`, `get-chat-messages`, `send-chat-message`) require the
   `Chat.ReadWrite` delegated permission, the shared-mailbox `from` parameter of
   `send-email`/`draft-email` requires the delegated `.Shared` mail scopes, and the SharePoint
   site tools (`list-sites`, `list-site-files`, `download-site-file`) require the delegated
   `Sites.Read.All` permission. If your Graph token was acquired before these scopes were added,
   re-acquire credentials by running
   `npm run auth-server` and completing the consent flow again (this re-issues Graph credentials;
   see the shared-file warning below).

3. Put the application client ID, client secret **value**, and tenant ID in `.env`:

   ```dotenv
   MS_CLIENT_ID=your-application-client-id
   MS_CLIENT_SECRET=your-client-secret-value
   MS_TENANT_ID=your-directory-tenant-id
   USE_TEST_MODE=false
   ```

4. Add the MCP server to your client. For Claude Desktop:

   ```json
   {
     "mcpServers": {
       "m365-assistant": {
         "command": "node",
         "args": ["/absolute/path/to/outlook-mcp/bin/m365-mcp.js", "mcp"],
         "env": {
           "OUTLOOK_CLIENT_ID": "your-application-client-id",
           "OUTLOOK_CLIENT_SECRET": "your-client-secret-value",
           "MS_TENANT_ID": "your-directory-tenant-id"
         }
       }
     }
   }
   ```

5. With Vault:

   ```json
   {
     "mcpServers": {
       "outlook-assistant": {
         "type": "local",
         "command": ["C:\\mcp\\outlook\\outlook-mcp-win-x64.exe", "mcp"],
         "environment": {
           "VAULT_ADDR": "https://vault.com",
           "VAULT_AUTH_MOUNT": "oidc",
           "VAULT_ROLE": "entra",
           "VAULT_OIDC_PORT": "8250",
           "VAULT_KV_MOUNT": "kv",
           "VAULT_SECRET_PATH": "apps/outlook-mcp/prod",
           "VAULT_SKIP_BROWSER": "false"
         },
         "enabled": true
       }
     }
   }
   ```

   See [`claude-config-sample.json`](./claude-config-sample.json) for a copyable file. The server uses stdio, so restart the MCP client after changing its configuration. With Vault enabled, call `setup-vault` once after the MCP server starts; later starts reuse the cache without opening a browser. You can also run the repository-level `vault-setup` command described below before starting the MCP client.

6. Call `authenticate`, copy the URL returned as the first response line, and open it in your browser. The browser is not opened automatically; the MCP tool starts the callback server automatically. Then call `check-auth-status` and use a Graph-backed tool such as `list-emails`.

Power Automate is optional and requires a second consent flow. Complete the Graph flow first, then call `authenticate-flow`. See [Power Automate](./docs/power-automate.md).

## Intranet MCP HTTP mode (Entra, delegated identity)

Besides the default stdio mode, the server can run as an authenticated intranet HTTP service: MCP clients connect to `/mcp` with a Microsoft Entra bearer token, and every request is served with that user's own delegated credentials (OAuth on-behalf-of flow) — never with local `.env` credentials.

> **Status: not yet validated against a real Entra tenant or Power Automate.** The transport, token verification, and authorization are covered by offline tests with synthetic signing keys; live Entra and live Power Automate behavior are still unproven. Keep the stdio mode as the production default until a real-tenant validation pass completes.

### Quick path

1. Register (or reuse) an Entra app for this MCP deployment and expose an API scope such as `api://<app>/mcp.access`. Users request this scope when they obtain a bearer token.
2. Configure the environment (see the variables below): tenant GUID, confidential-client credentials, the audience for this deployment, and the required delegated scope.
3. Start it: `m365-mcp http` (or `node bin/m365-mcp.js http`). Verify `https://<host>/.well-known/oauth-protected-resource` returns the discovery document.
4. Bind it to the loopback address and terminate TLS at your reverse proxy for the intranet; direct non-loopback binds without TLS are refused at startup.

### What the mode enforces

- Every request must carry a valid delegated bearer token (signature via tenant JWKS, issuer, audience, tenant, expiry, user identity, and the required delegated scope). Unauthenticated requests get `401` with OAuth protected-resource discovery metadata; misconfigured or insecure setups refuse to start.
- The local `authenticate`, `setup-vault`, `check-auth-status`, `authenticate-flow`, `stop-auth-server`, and `about` tools are not exposed over HTTP; they would bypass per-request credential isolation.
- Every verified authenticated identity runs the same tool set; there is no separate MCP mutation gate or read-only allowlist. Authorization beyond delegated authentication is owned by the Entra enterprise-application assignment (which controls who can obtain a token for this API) and by each user's own Microsoft 365 permissions behind the on-behalf-of exchange: a Microsoft 365 denial (for example a public Graph `403`) surfaces to the client unchanged.
- Each HTTP request gets its own connection and its own token store; concurrent requests never share an identity, and tokens are never cached on disk or logged.

### Configuration variables

| Variable                                    | Required                                           | Default                                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------- | -------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENTRA_TENANT_ID`                           | yes                                                | —                                             | Specific tenant GUID; `common` is refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET`   | yes                                                | —                                             | Confidential client for the on-behalf-of exchange                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MCP_HTTP_AUTH_MODE`                        | no (explicit selector)                             | _(auto)_                                      | Exactly `entra` (direct Entra mode, optional) or `bridge` (the chosen persistent standards OAuth sign-in flow, renewed through the tenant refresh grant); unset keeps the known auto-selection: bridge iff `MCP_HTTP_LOGIN_REDIRECT_URI` is set, direct Entra otherwise; any other value refuses startup. No separate per-agent Entra application is required for the bridge                                                                                                                                    |
| `MCP_HTTP_AUDIENCE`                         | yes                                                | —                                             | Audience (`aud`) your tokens carry for this MCP deployment: with the Entra v2.0 endpoint this is the API app's **client ID GUID** (a v1-style token would carry the app ID URI — set exactly what your tokens carry)                                                                                                                                                                                                                                                                                            |
| `MCP_HTTP_REQUIRED_SCOPES`                  | yes                                                | —                                             | Space/comma-separated **short scope names** required from every token's `scp` claim (API-qualified `api://…` URIs are refused here)                                                                                                                                                                                                                                                                                                                                                                             |
| `MCP_HTTP_UPSTREAM_SCOPES`                  | bridge sign-in flow, or direct-mode scope override | —                                             | Resource-qualified delegated scope(s) (`api://<app-id>/<scope>` or `https://<host>/<scope>`) requested from Entra: the upstream authorization scope of the bridge sign-in flow, or in direct mode the resource-qualified scopes advertised in discovery and challenges; otherwise derived as `api://<client id>/<required short scope>`, never guessed                                                                                                                                                          |
| `MCP_HTTP_PORT`                             | no                                                 | `3000`                                        | Listener port                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `MCP_HTTP_HOST`                             | no                                                 | `127.0.0.1`                                   | Must be loopback unless TLS is configured; the single plaintext exception is the explicit `MCP_HTTP_ALLOW_LOCAL_HTTP=true` local-development mode (container published on the host loopback)                                                                                                                                                                                                                                                                                                                    |     |
| `MCP_HTTP_TLS_CERT` / `MCP_HTTP_TLS_KEY`    | no                                                 | —                                             | PEM file paths; enable a direct HTTPS listener                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MCP_HTTP_ALLOWED_ORIGINS`                  | no                                                 | _(deny all Origin headers)_                   | Comma-separated `https://` origins accepted from browsers                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `MCP_HTTP_EXTERNAL_BASE_URL`                | no                                                 | _(listener host/port)_                        | Public URL used in discovery metadata; **required** for wildcard binds such as the Compose container's `0.0.0.0` — never the request `Host` header                                                                                                                                                                                                                                                                                                                                                              |
| `MCP_HTTP_LOGIN_REDIRECT_URI`               | bridge mode only                                   | —                                             | The exact callback URL registered for this service's browser sign-in (usually `https://<your-host>/login/callback`); in bridge mode (auto-selected exactly when this is set, or forced with `MCP_HTTP_AUTH_MODE=bridge`) it enables the standards MCP OAuth login flow below. Direct `entra` mode ignores it, together with the bridge-only client settings below. A plaintext `http://` value is accepted only when it targets an exact loopback host **and** the explicit local-development mode below is set |
| `MCP_HTTP_ALLOW_LOCAL_HTTP`                 | no (explicit opt-in)                               | _(off)_                                       | **Local development only.** Exactly `true` (any other value refuses startup) accepts the plaintext loopback Entra callback and a plaintext wildcard container listener published on the host loopback; never acceptable for intranet or public deployments                                                                                                                                                                                                                                                      |
| `MCP_HTTP_BRIDGE_STORE_DIR`                 | bridge mode (required for durable persistence)     | `~/.outlook-mcp/remote-oauth`                 | Durable directory of the encrypted bridge credential store (refresh-token families, delegated identities, server-held upstream refresh credentials). In container deployments set it to a durable mounted volume (the Compose mount uses `/app/data/oauth`); without it the CLI bridge persists under the platform state directory, which dies with an unmounted container filesystem                                                                                                                           |
| `MCP_HTTP_BRIDGE_KEY_FILE`                  | bridge mode only                                   | _(auto-generated key in the store directory)_ | Optional separate, already-mounted key file with exactly 32 key bytes for the bridge store. The key and the encrypted snapshot must be backed up together, used by exactly one replica, and never share a file                                                                                                                                                                                                                                                                                                  |
| `MCP_HTTP_OAUTH_CLIENTS`                    | bridge mode only                                   | _(deny all external clients)_                 | JSON array of pre-registered external MCP clients: `[{"clientId":"…","clientSecret":"…","redirectUris":["https://client.example/cb"]}]`; `clientSecret` is optional for public clients                                                                                                                                                                                                                                                                                                                          |
| `MCP_HTTP_OAUTH_SUPPORTED_SCOPES`           | no                                                 | `mcp`                                         | MCP scope(s) external clients may request                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `MCP_HTTP_OAUTH_ALLOW_DYNAMIC_REGISTRATION` | no                                                 | `false`                                       | Opt-in SDK dynamic client registration; prefer pre-registration                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Test mode (`USE_TEST_MODE=true`) and the HTTP mode are mutually exclusive; combining them refuses startup. Discovery metadata and the RFC 9728 challenge URL are built only from trusted configuration: the explicit `MCP_HTTP_EXTERNAL_BASE_URL` when set, otherwise the listener's own validated host and port — the untrusted request `Host` header is never reflected. A wildcard bind (`0.0.0.0`, `::`) has no usable listener-derived discovery URL, so the startup **fails closed** unless `MCP_HTTP_EXTERNAL_BASE_URL` is explicitly configured. Behind a reverse proxy, keep `ENTRA_CLIENT_SECRET` and `MCP_HTTP_AUDIENCE` in the protected runtime environment, and set `MCP_HTTP_EXTERNAL_BASE_URL` to the proxy's HTTPS URL so discovery metadata advertises the correct address.

### Direct Entra authorization-server mode (optional, unchanged)

In direct mode (`MCP_HTTP_AUTH_MODE=entra`, implicit when no bridge configuration is set), discovery (`/.well-known/oauth-protected-resource`) advertises **only** the tenant Entra issuer and the **fully resource-qualified** request scopes (for example `api://<client id>/mcp.access`, derived with the same helper as the bridge upstream scope, or exactly `MCP_HTTP_UPSTREAM_SCOPES` when set), and the RFC 9728 `WWW-Authenticate` challenge carries that same `scope=` list. Token verification is unchanged and stays **short**: `aud` is the configured audience (the API app's client ID GUID for v2 tokens) and `scp` must carry the short `MCP_HTTP_REQUIRED_SCOPES` name(s). The protected-resource `resource` field stays this deployment's canonical base URL — it is never fabricated into an `api://` URI, and no server-side credential renewal subsystem exists: MCP clients own and refresh their Entra tokens.

**Entra prerequisites for a standards MCP client such as Pi 1.5.2 (verified against Pi's public code, not yet verified against a live tenant):**

1. The MCP service app continues to be the confidential resource application exposing the delegated API scope (`api://<client id>/mcp.access` or a custom Application ID URI via `MCP_HTTP_UPSTREAM_SCOPES`) and holding the on-behalf-of exchange credentials.
2. Separately, register a **public client** application ("Allow public client flows": yes) for the agents. It needs **no client secret** — agents never hold Entra secrets — and a **Desktop/native** redirect URI that matches the client's actual loopback callback exactly. Pi 1.5.2's callback is `http://127.0.0.1:<port>/callback` (with `oauth.callbackPort`), or set `oauth.callbackUrl` to an exactly registered loopback URI; **do not invent a `localhost` substitute for an entry registered as `127.0.0.1`** — register the exact URI Pi sends. Azure's portal may only accept `http://localhost` loopback entries on the Mobile-and-desktop platform; verify the exact `127.0.0.1:<port>` registration against your tenant before relying on it.
3. Point the client at this deployment as usual so it reads the protected-resource metadata, and configure its requested scopes to include `offline_access` alongside the resource-qualified API scope (Pi: `oauth.scope: "api://<client id>/mcp.access offline_access"`; Pi's discovery-based default would otherwise omit `offline_access` and no refresh token would be issued). Pi can also reach the Entra issuer directly via `oauth.authServerMetadataUrl: "https://login.microsoftonline.com/<tenant>/v2.0/.well-known/openid-configuration"`.

**Unverified interoperability (documented honestly, not worked around):** MCP standards clients send the protected-resource `resource` value (this deployment's base URL) as the RFC 8707 `resource` parameter on their Entra authorization, token, and refresh requests. Whether the Entra tenant accepts that unqualified-host value — as opposed to requiring a registered Application ID URI — could not be verified without a live tenant, so **direct mode's client compatibility is implemented as the correct server-side seam and documented as unverified, not turnkey**. Do not strip the resource parameter or substitute the `api://` URI in discovery to mask this; the server keeps the standards behavior and this question needs one live-tenant validation pass.

### Bridge sign-in for external MCP clients (the chosen persistent bridge)

When the bridge configuration is complete (`MCP_HTTP_LOGIN_REDIRECT_URI` plus registered clients or explicit dynamic registration, or `MCP_HTTP_AUTH_MODE=bridge`), the service runs the **standards MCP authorization-code flow** (OpenCode/LibreChat/Claude/Codex-style clients connect to the same `/mcp` endpoint and sign in first, then consult the tools):

1. Configure two Entra applications. The **MCP service app** (the same confidential client as before) needs a registered **Web** redirect URI exactly `https://<your-host>/login/callback`, and its exposed API scope (for example `api://<app>/mcp.access`) — no audience or scope configuration is needed when the scope lives on the app that owns `ENTRA_CLIENT_ID`: the upstream authorization scope then derives to `api://<client id>/<required short scope>` (default `mcp.access`). If the app's **Application ID URI differs from `api://<client id>`**, set `MCP_HTTP_UPSTREAM_SCOPES=` that `api://<app>/<scope>` string explicitly (and, when the issued tokens then carry an audience other than the client ID GUID, also `MCP_HTTP_AUDIENCE=` what the tokens carry; the required short scope then derives from the upstream override, or set `MCP_HTTP_REQUIRED_SCOPES=` explicitly). Per external client, pre-register the client in `MCP_HTTP_OAUTH_CLIENTS` with its exact redirect URI (never a shared wildcard); external clients never receive Entra client secrets.
2. The external MCP client starts `/authorize?response_type=code&client_id=…&redirect_uri=…&scope=mcp&state=…&code_challenge=…&code_challenge_method=S256`. Unregistered clients and unregistered redirects are refused; PKCE S256 is mandatory. No separate per-agent Entra application is required: each client is only pre-registered in `MCP_HTTP_OAUTH_CLIENTS` with its exact loopback callback and requests the plain `mcp` scope. Pi 1.5.2, for example, registers its own local callback `http://127.0.0.1:8765` and requests scope `mcp`.
3. The browser reaches a **service-owned consent page** that names the requesting client, its exact registered redirect, and the requested permissions, protected by a one-time CSRF token on the consent submission, a strict browser-origin gate on every browser submission, `strict-origin` referrals (the browser sends its exact true `Origin` on the same-origin form submission, and the page URL — whose query carries the OAuth authorization reference — is never referred anywhere, with the `Referer` reduced to the bare origin even same-origin), strict anti-framing headers, and no scripts, images, or password fields (the actual sign-in happens at Microsoft; the page only shows a plain "Continue to Microsoft sign-in" button). The consent page's CSP `form-action` allowlist is exactly `'self'` plus — for that one navigation only — the server-trusted configured Entra authorization origin (real Chromium re-checks the initiating page's `form-action` across the consent form's redirect to Microsoft; a `'self'`-only policy blocked that redirect in real browsers and left the stranded page failing closed against the already-consumed one-time CSRF, which shows the bounded `csrf-failed` recovery guidance instead of granting anything; re-open the sign-in page to get a fresh one-time CSRF). No registered client redirect and no unregistered origin is ever a form target.
4. Only after explicit consent does the browser go to Microsoft's real tenant sign-in (`remote/entra-login.js`), using a one-time `state`, a bound `nonce`, and PKCE against Entra. The ID token's signature, issuer (your authority), audience, expiry, tenant, and `nonce` are verified.
5. The browser is then returned to the **exact registered client redirect** carrying only the single-use authorization code and state; the client exchanges it at `POST /token` (secret or PKCE for public clients) for an MCP-scoped bearer token bound to its requested resource (RFC 8707). Before any binding, the service also re-verifies the upstream access token Entra returned in the same token response — signature via the tenant JWKS, issuer, the configured API audience, tenant, expiry, the short scp scope names, and the same user object ID as the verified ID token; a token that fails closed never reaches the MCP authorization or the on-behalf-of exchange.
6. Tools are invoked with that bearer token at `/mcp`; each request exchanges the server-side retained upstream Entra token on-behalf-of that user, renewing it near expiry from the service-held refresh credential (see below), so a signed-in user's access keeps working without a fresh browser sign-in while the upstream credential remains usable.

The bridge is **persistent and renewing** (T19): the upstream sign-in additionally requests `offline_access`, the confidential client secret stays server-side, and the service redeems the upstream refresh credential at the tenant-pinned token endpoint when the upstream credential nears expiry — once per family under a singleflight, verified with the same existing Entra verifier (signatures, issuer, configured API audience, tenant, expiry, delegated scp scopes) and bound to the immutable delegated `oid`/`tid` before the renewed credential (and, when Microsoft rotated it, the new refresh credential) is committed into the **encrypted durable store** (`MCP_HTTP_BRIDGE_STORE_DIR`, AES-256-GCM, exact deployment binding: canonical service URL, tenant, client — see [OAuth persistence](docs/oauth-persistence.md)). Only a genuinely unusable upstream credential — Microsoft's own reauth conditions (`invalid_grant`, `interaction_required`, `consent_required`, `login_required`) or a mismatched renewed credential — permanently invalidates that one family and requires the browser sign-in again; client/configuration errors and transient upstream failures never wipe a grant, and `/mcp` answers `503 temporarily_unavailable` while the upstream renewal is briefly unavailable (retry, never a fallback token). MCP clients receive rotating one-time refresh tokens bound to client, user, resource, and scopes, with replay-protection revocation exactly as described in the persistence doc.

Deliberate limitations (do not assume advertised features that do not exist): this is **not an eternal login** — the upstream refresh credential itself expires and must be re-consented eventually, only in-progress browser sign-ins evaporate on a restart (issued grants, identities, and refresh families survive via the store), dynamic client registration is disabled by default, there is no revocation endpoint, and stateless clustering is unsupported (the store is single-replica). Clients must support `authorization_code` with S256 PKCE for web/native redirect URIs; per-client optional capabilities were not verified against real MCP clients.

While the bridge flow is enabled, the raw delegated Entra bearer-token path described above keeps working for identities that already hold access tokens.

> **Status: not validated against a real Entra tenant, a real on-behalf-of exchange, or a real external MCP client.** The flow is covered by offline tests with synthetic keys and a mocked Microsoft token endpoint; an independent security proof of this slice was not produced. Do not expose it beyond the intranet without that validation.

### Docker Compose (direct TLS listener in the container)

A separate reverse-proxy container cannot reach an MCP listener bound to the container's own loopback, so the provided `compose.yaml` runs the TLS termination **inside** the MCP container: the listener binds all container interfaces (`0.0.0.0`) behind a required TLS certificate, and Docker publishes it to the **host loopback address by default** (`127.0.0.1`). Exposing the service to the intranet is always an explicit administrator step.

Quick path:

1. Create a `tls/` directory next to `compose.yaml` holding `cert.pem` (your full certificate chain) and `key.pem` (matching key, readable by Linux uid `1000`, which is the non-root container user).
2. Create your git-ignored and docker-ignored `.env.docker` file from the documented dummy sample `docker-env.example`, and fill in the Entra tenant GUID, confidential-client credentials, and `MCP_HTTP_EXTERNAL_BASE_URL` (the externally reachable `https://` URL MCP clients use; because the container binds `0.0.0.0`, the listener refuses to start without it). The token audience and delegated scope derive from the client ID v2 defaults; the sample documents the optional `MCP_HTTP_AUDIENCE`/`MCP_HTTP_REQUIRED_SCOPES`/`MCP_HTTP_UPSTREAM_SCOPES` overrides. `.env.docker` is only read at container start and never baked into the image.
3. `docker compose up -d --build` (use `docker compose -p <name>` to isolate the project). Verify `https://127.0.0.1:8443/.well-known/oauth-protected-resource` returns the discovery document and that an unauthenticated request to `/mcp` gets `401` with `WWW-Authenticate` metadata.
4. To publish on the intranet instead of only the host loopback, set `MCP_HTTP_PUBLISHED_HOST` (for example the intranet interface address or `0.0.0.0`) and `MCP_HTTP_PUBLISHED_PORT` in the shell or Compose environment, and serve a certificate your intranet clients trust from `tls/`.

### Durable bridge persistence in the container deployment

Both Compose configs mount a **project-scoped named volume** at `/app/data/oauth` and set `MCP_HTTP_BRIDGE_STORE_DIR` to that path, so signed-in users keep their MCP sessions (and the service keeps its encrypted upstream refresh credentials) across container recreation and restarts. The image prepares the directory empty, owned by uid `1000` with mode `0700`; no store, key, or credential is ever built into the image. The Compose files pin `deploy.replicas: 1` — the encrypted store is a single-node directory, not a distributed-lock cluster store.

| Rule                   | What is true                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restarts               | Live sessions and refresh families survive container recreation and `up`/`down`/`restart` cycles through the volume. The first sign-in of each user must be a **fresh** one: it is what requests `offline_access` from Microsoft so the bridge can store the encrypted Entra refresh credential the client never sees.                             |
| Lost volume/key        | If the volume or the `bridge-store.key` inside it is lost, **every sign-in in it is gone and cannot be recovered**: nothing may be blanked or guessed. Every user has to repeat the Microsoft sign-in.                                                                                                                                             |
| Never wipe by accident | Do **not** run `docker compose down -v` (or `docker volume rm`) for this project unless losing every stored grant intended. `down` alone keeps the volume.                                                                                                                                                                                         |
| Backups                | Back up the volume contents — the encrypted `bridge-store.bin` **and** its `bridge-store.key` **together** — restricted like credential material; restoring only one of the two is useless.                                                                                                                                                        |
| One replica            | Run exactly **one** replica (`deploy.replicas: 1`); there is **no distributed lock**, and scaling `mcp-http` beyond one live replica conflicts on the shared store (`BRIDGE_STORE_CONCURRENT_WRITE`).                                                                                                                                              |
| Private boundary       | Keep the publishing loopback-pinned (both configs default to `127.0.0.1`); the store volume holds MCP and upstream credential material and must stay on the trusted host. The login is **not an eternal login**: the upstream refresh credential itself expires and the user must sign in again eventually — no perpetual-login guarantee is made. |

### Local development (Docker, HTTP only — explicit opt-in)

For purely local functional testing (`compose.local.yaml`), a separate Compose config runs the same service **without TLS** under an explicitly opted-in local development mode (`MCP_HTTP_ALLOW_LOCAL_HTTP=true`, set by the config itself). This mode exists only because a loopback browser flow on `http://localhost` needs no TLS and Microsoft permits plain HTTP redirect URIs **only for loopback addresses**; it is never acceptable for intranet or public deployments, and production users keep using `compose.yaml` with TLS.

Quick path:

1. Create your `.env.docker` from `docker-env.example` exactly as for the TLS deployment (Entra tenant, confidential-client credentials; the v2 audience/scope defaults derive from the client ID). You do **not** need to change your existing HTTPS values: `compose.local.yaml` overrides the two HTTPS-specific keys to their plaintext loopback equivalents (`MCP_HTTP_EXTERNAL_BASE_URL=http://localhost:8443`, `MCP_HTTP_LOGIN_REDIRECT_URI=http://localhost:8443/login/callback`) inside the local config itself.
2. One-time Entra change: register the loopback HTTP callback `http://localhost:8443/login/callback` as a Web platform redirect URI on the MCP service app (keep the HTTPS one for production; Microsoft accepts plain HTTP redirect URIs for loopback addresses only).
3. `docker compose -f compose.local.yaml up -d --build` (the published-port variable for a different host port is `MCP_HTTP_PUBLISHED_PORT`, default `8443`; the host side is hard-pinned to `127.0.0.1` and cannot be pointed at a public or intranet interface through this file). Verify `http://127.0.0.1:8443/.well-known/oauth-protected-resource` returns the discovery document and that an unauthenticated request to `/mcp` gets `401` with `WWW-Authenticate` metadata.
4. `docker compose -f compose.local.yaml down` when done.

What the local mode deliberately trades away (and why it is safe enough only locally):

- The listener inside the container is plaintext HTTP; **traffic inside your local Docker bridge network is unencrypted and may be visible to other local Docker workloads** (any container with packet-capture access to that network can read it, including Entra authorization codes in transit to Microsoft). Docker publishes the port exclusively to the host loopback, so no process outside the machine can reach it without the usual localhost privileges.
- The server still refuses to bind anything but loopback addresses or the pinned-loopback-published container wildcard: real intranet addresses (for example `10.1.2.3` or `intranet.example`) and non-loopback plaintext callback or base URLs stay refused even with `MCP_HTTP_ALLOW_LOCAL_HTTP=true`, and the value-exact `true` requirement means a typo cannot silently enable the mode.

### Canonical URL and TLS trust in the container deployment

MCP clients must use one **canonical `https://` URL** for the deployment, set exactly as `MCP_HTTP_EXTERNAL_BASE_URL`; that same URL — not the listener bind and not the request `Host` header — is what discovery metadata, OAuth issuer metadata, and `WWW-Authenticate` challenges advertise. For a local functional test the canonical URL can be `https://localhost:<published-port>` (the default publish target is `127.0.0.1`), which also makes it the OAuth issuer for the standards sign-in flow when enabled.

The certificate served from `tls/` must carry that canonical hostname in its subject alternative names, and every client must trust it explicitly — operating systems and browsers do **not** trust a self-generated or internal test CA by default. With `curl`, pass the issuing CA once instead of disabling verification (`-k`/`--insecure` defeats the purpose of the TLS listener and is unsafe): `curl --cacert tls/ca.pem https://localhost:8443/.well-known/oauth-protected-resource`. For intranet clients, obtain the certificate from your own trusted internal CA (or a publicly trusted CA) so trust comes from the client's normal trust store; the container never needs or reads client-side CA configuration. For OAuth clients to complete the standards flow, their redirect URIs registered in `MCP_HTTP_OAUTH_CLIENTS` must in turn use URLs their own clients trust — per-client support was not verified against real MCP clients and is not claimed.

| Compose variable (shell/Compose environment) | Default     | Meaning                                                                                                                     |
| -------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| `MCP_HTTP_PUBLISHED_HOST`                    | `127.0.0.1` | Host address the container port is published on. Keep the loopback default unless you explicitly opt into an intranet bind. |
| `MCP_HTTP_PUBLISHED_PORT`                    | `8443`      | Host port published for `MCP_HTTP_PUBLISHED_HOST`.                                                                          |
| `MCP_HTTP_TLS_DIR`                           | `./tls`     | Directory mounted read-only into the container at `/run/tls` (expects `cert.pem` and `key.pem`).                            |

| File                 | Role                                                                                                                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`         | Builds from `node:22.22.1-bookworm-slim`; installs only locked production dependencies; runs as the unprivileged `node` user (uid 1000); starts `node bin/m365-mcp.js http`.                                                                                                                  |
| `.dockerignore`      | Whitelist: build context is empty by default, so node_modules, `.git`, `.env*`, tokens, and PEM keys can never enter the image.                                                                                                                                                               |
| `compose.yaml`       | Single service; no host networking, no privileged mode; the container filesystem is read-only with a `/tmp` tmpfs; runtime TLS from a read-only mount; durable bridge store on the project-scoped `bridge_oauth` named volume at `/app/data/oauth` (`deploy.replicas: 1`).                    |
| `compose.local.yaml` | **Local development only:** same service without TLS under the explicit `MCP_HTTP_ALLOW_LOCAL_HTTP=true` opt-in, published hard-pinned to `127.0.0.1`; no TLS mount exists; durable bridge store on the distinct `bridge_oauth_local` named volume and `MCP_HTTP_AUTH_MODE=bridge` forced on. |
| `docker-env.example` | Dummy-value template for the git-ignored `.env.docker` runtime configuration.                                                                                                                                                                                                                 |

The container itself never holds credentials: Entra secrets arrive through the runtime-only `env_file`, per-user tokens exist only in memory per request, and the local stdio token file is not present in the image. Keep the stdio mode exactly as before for local desktop clients.

> **Status (unchanged): not yet validated against a real Entra tenant or Power Automate, including through this container deployment.** The containerized listener is proven with offline-generated self-signed test certificates and fake configuration values only; live Entra token verification and live on-behalf-of exchange through Docker remain unproven.

## Pre-built executables

Standalone executables are published as GitHub Release assets. They include the MCP server and the authentication callback server in one file, and **do not require Node.js or npm** on the machine that runs them.

| Target      | Artifact                  | Platform                                |
| ----------- | ------------------------- | --------------------------------------- |
| Windows x64 | `outlook-mcp-win-x64.exe` | Windows 10/11, x64                      |
| Linux x64   | `outlook-mcp-linux-x64`   | Linux x64, glibc ≥ 2.39 (Ubuntu 24.04+) |

Windows file Properties identify the executable as **M365 Assistant MCP Server** from **ACTSIS** and show the package/release version. The embedded Node.js runtime is an implementation detail of the standalone build.

1. Open the [Releases](https://github.com/rafaga2469/outlook-mcp/releases) page and pick a release whose version matches your needs. Releases are created only from pushed tags; branches never publish.
2. Download the artifact for your platform. On Linux, make it executable:

   ```bash
   chmod +x outlook-mcp-linux-x64
   ```

3. Configure the runtime credentials as described below.
4. Launch the MCP mode from the downloaded file. The MCP mode is the default, so the argument is optional:

   ```text
   outlook-mcp-win-x64.exe mcp
   ./outlook-mcp-linux-x64 mcp
   ```

   The `auth` mode serves the browser callback on `http://localhost:3333`:

   ```text
   outlook-mcp-win-x64.exe auth
   ./outlook-mcp-linux-x64 auth
   ```

   In MCP mode, the executable relaunches itself in `auth` mode when an authentication tool needs the callback server, so one file covers the whole flow. If a future release must use separate fallback artifacts, it will document `outlook-mcp-<target>-mcp` and `outlook-mcp-<target>-auth` names and the same mode-specific invocation.

Maintainers can publish a semantic release from GitHub Actions by running **Semantic version** on `main` and selecting `patch`, `minor`, or `major`. The workflow dispatches CI for the current `main` commit and waits for success before updating package metadata, pushing the matching version tag, and invoking the release pipeline. It uses the repository's built-in `GITHUB_TOKEN`; no personal access token is required.

### Intranet installation (ACTSIS ProGet)

ACTSIS collaborators can install releases from the corporate ProGet Asset Directory at `https://artifacts.actsis.com`. Assets live in the dedicated `outlook-mcp` asset directory, under the `releases/` prefix:

- Versioned assets: `https://artifacts.actsis.com/endpoints/outlook-mcp/content/releases/<version>/<file>`
- `latest-stable.json` manifest: `https://artifacts.actsis.com/endpoints/outlook-mcp/content/releases/latest-stable.json`

The public GitHub Releases channel remains available; use whichever channel your environment can reach. Both the raw Linux binary and the `.deb` require **glibc ≥ 2.39 (Ubuntu 24.04+)**.

#### Windows

1. Download `outlook-mcp-setup.exe` for the desired version from ProGet.
2. Run the installer (administrator rights are required). It installs `outlook-mcp.exe` under `C:\Program Files\outlook-mcp`, appends that directory to the machine `PATH`, and registers an uninstall entry.
3. Restart your terminal so the new `PATH` is available.
4. Launch MCP mode:

   ```text
   outlook-mcp.exe mcp
   ```

   The `auth` mode serves the browser callback on `http://localhost:3333`:

   ```text
   outlook-mcp.exe auth
   ```

#### Linux

1. Download `outlook-mcp_<version>_amd64.deb` from ProGet.
2. Install it. `dpkg` is enough for a first install; `apt` resolves dependencies automatically if they are missing:

   ```bash
   sudo dpkg -i outlook-mcp_<version>_amd64.deb
   ```

   or

   ```bash
   sudo apt install ./outlook-mcp_<version>_amd64.deb
   ```

3. The package installs the executable at `/usr/bin/outlook-mcp`. Launch it directly:

   ```bash
   outlook-mcp mcp
   outlook-mcp auth
   ```

#### Credential configuration for installed binaries

Installed binaries cannot rely on a `.env` file beside the executable: `/usr/bin` and `C:\Program Files\outlook-mcp` are not user-writable without elevation. Instead, supply credentials through the MCP-client `env` block, or use Vault mode. See [Authentication](./docs/authentication.md) for the full Vault setup and the variable reference.

#### Do not rename the executable

The single-executable dispatch probe looks for the lowercase substring `outlook-mcp` in the file name. Renaming `outlook-mcp.exe` or `/usr/bin/outlook-mcp` will break startup. Keep the installed name exactly as the installer wrote it.

### Runtime configuration for pre-built executables

Runtime configuration is external. The build does not receive OAuth credentials, and the downloaded binary does not contain them. Use either process environment variables or a `.env` file in the **same directory as the executable**.

#### Supported variables

The server can start without credentials, but the first Graph or Power Automate authentication and any token refresh require a client ID and client secret. Use one name from each alias pair; when both non-empty aliases are set, the `OUTLOOK_*` value wins.

| Variable                                      | Required?                               | Controls                                                                                                                         |
| --------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `OUTLOOK_CLIENT_ID` or `MS_CLIENT_ID`         | Required for authentication and refresh | Microsoft Entra application (client) ID. `OUTLOOK_CLIENT_ID` takes precedence over `MS_CLIENT_ID`.                               |
| `OUTLOOK_CLIENT_SECRET` or `MS_CLIENT_SECRET` | Required for authentication and refresh | Microsoft Entra client secret **value**, not the secret ID. `OUTLOOK_CLIENT_SECRET` takes precedence over `MS_CLIENT_SECRET`.    |
| `MS_TENANT_ID`                                | Optional                                | Tenant used by the identity endpoints. Defaults to `common`; set a tenant GUID for a single-tenant app.                          |
| `MS_AUTHORITY_HOST`                           | Optional                                | Identity authority host. Defaults to `https://login.microsoftonline.com`; trailing slashes are removed.                          |
| `MS_SCOPES`                                   | Optional advanced override              | Space-separated scopes used by the active auth server and `TokenStorage`. Include `offline_access` when overriding it.           |
| `MS_REDIRECT_URI`                             | Optional advanced override              | Redirect URI used by the active auth server and `TokenStorage`; defaults to `http://localhost:3333/auth/callback`.               |
| `MS_TOKEN_ENDPOINT`                           | Optional advanced override              | Token endpoint used by the active auth server and `TokenStorage`; defaults to the v2 endpoint derived from authority and tenant. |
| `USE_TEST_MODE`                               | Optional                                | Uses test API responses when set to `true`; defaults to `false` and should remain disabled for real accounts.                    |

`MS_SCOPES`, `MS_REDIRECT_URI`, and `MS_TOKEN_ENDPOINT` are optional overrides for both active acquisition and refresh/exchange. Leave them unset unless you specifically need a non-default configuration.

#### HashiCorp Vault for intranet developers

Vault mode keeps OAuth values outside the public executable and outside developer MCP configuration. It is **intranet-only**: the developer machine must be able to reach `VAULT_ADDR` through the corporate network, VPN, or NetBird as required by the local environment. GitHub Actions does not connect to Vault, ProGet, or NetBird for the public release.

Set `VAULT_ADDR` to enable Vault mode. The other settings are optional:

| Variable                              | Default                 | Purpose                                                                                      |
| ------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `VAULT_ADDR`                          | Disabled when unset     | Intranet Vault HTTP(S) address; enables Vault mode                                           |
| `VAULT_AUTH_MOUNT`                    | `oidc`                  | Vault JWT/OIDC auth mount                                                                    |
| `VAULT_ROLE`                          | `outlook-mcp-developer` | OIDC role used for developer login                                                           |
| `VAULT_OIDC_PORT`                     | `8250`                  | Loopback callback port                                                                       |
| `VAULT_KV_MOUNT`                      | `kv`                    | KV v2 mount                                                                                  |
| `VAULT_SECRET_PATH`                   | `outlook-mcp/actsis`    | KV v2 secret path                                                                            |
| `VAULT_NAMESPACE`                     | Unset                   | Optional Vault Enterprise namespace                                                          |
| `VAULT_SKIP_BROWSER`                  | `false`                 | Set to `true` for manual URL flow; the URL is printed to stderr and the callback stays local |
| `VAULT_CUSTOM_HEADER_NAME`            | Unset                   | Optional custom HTTP header name sent with every Vault API request                           |
| `VAULT_CUSTOM_HEADER_VALUE`           | Unset                   | Sensitive value paired with `VAULT_CUSTOM_HEADER_NAME`; never logged or persisted            |
| `VAULT_TOKEN_CACHE_PATH`              | OS-specific             | Optional local path override for the per-user Vault token cache                              |
| `VAULT_TOKEN_RENEW_THRESHOLD_SECONDS` | `300`                   | Renew a renewable cached token when this many seconds or less remain                         |
| `VAULT_TOKEN`                         | Unset                   | Automation/testing escape hatch; no browser flow, never persisted or logged                  |

When `VAULT_TOKEN` is absent, call the `setup-vault` MCP tool once to complete the Vault OIDC browser flow. The runtime stores that Vault token and safe lease metadata in a per-user local cache. Later OpenCode/MCP launches validate the cached token, renew it when it is renewable and near expiry, and read the KV values without opening a browser. If the cache is missing, stale, or unusable, normal startup remains available in a setup-required state and does not open a browser; call `setup-vault` explicitly. The local listener accepts only `GET http://127.0.0.1:<port>/oidc/callback`; the Vault role and the OIDC provider must allow the matching `http://localhost:<port>/oidc/callback` URI. With the defaults, configure `http://localhost:8250/oidc/callback` exactly. Static `VAULT_TOKEN` values are not recommended for developer installs. If Vault itself is sealed, every request fails with `VAULT_SEALED` (HTTP 503, `Vault is sealed`); this is a server-side condition that only a Vault operator can resolve with `vault operator unseal`, after which `setup-vault` or normal startup works again without further local changes.
When `VAULT_TOKEN` is present, it remains the explicit non-cached automation/testing credential and takes precedence over the OIDC cache; neither normal startup nor `setup-vault` opens a browser for that mode.
After sign-in, the identity-provider redirect must return the matching `state` and a `code`. The client retains the `nonce` from Vault's authorization URL for the callback exchange; if the provider returns a nonce too, it must match.
If the Vault browser cannot be opened, the complete short-lived authorization URL is copied to the system clipboard and printed for manual use. Clipboard support is best-effort and never blocks Vault setup.

For a repository-level manual setup, use the dispatcher rather than the MCP client's remote OAuth command:

```powershell
# Source checkout
node bin/m365-mcp.js vault-setup
npm run vault-setup

# Packaged Windows executable
.\outlook-mcp-win-x64.exe vault-setup
```

This command loads the external `.env`, performs the explicit Vault browser/manual flow, saves the Vault identity cache, and reports only safe status. It exits `0` after a successful setup, `1` for a setup/runtime failure, and `2` when Vault is disabled or misconfigured. Do not use OpenCode's `opencode mcp auth <name>` for this local command: the current OpenCode command is documented for remote OAuth MCP servers and cannot invoke an arbitrary local stdio subcommand. The existing `m365-mcp-auth` package entry remains the Microsoft callback-server entry point.

#### TLS and the Windows certificate store

Node 22.22.1 and the packaged Node runtime merge Node's bundled public CA roots with certificates already installed in the Windows/system certificate store before productive HTTPS calls. TLS certificate verification remains enabled. Customers do not need to export/import a PEM file or set `NODE_EXTRA_CA_CERTS` for a CA that is already installed in the system store. Never disable verification with `NODE_TLS_REJECT_UNAUTHORIZED=0` or `rejectUnauthorized: false`.

#### Vault token cache

The cache contains only the short-lived Vault client token, its expiration/TTL metadata, its renewable flag, and a save timestamp. It never contains `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID`, or any other KV value. Those values are fetched from Vault into process memory on every startup or explicit setup.

Default cache locations are:

| Platform    | Path                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Windows     | `%LOCALAPPDATA%\m365-mcp\vault-token.json` (falls back to `%APPDATA%`, then the user home directory) |
| Linux/POSIX | `${XDG_CONFIG_HOME:-~/.config}/m365-mcp/vault-token.json`                                            |

Set `VAULT_TOKEN_CACHE_PATH` to choose another local path for tests or administrator-managed installations. The cache is written atomically, and startup coordinates concurrent terminals with an exclusive `vault-token.json.lock` sidecar around cache validation, renewal, and explicit setup. POSIX systems use mode `0600`, and Windows applies restrictive best-effort file handling under the current user profile.

To force another Vault login, delete the cache file and call `setup-vault`; normal startup will not open OIDC automatically. If Microsoft Entra permanently rejects the configured OAuth grant or client during token exchange/refresh, the matching Vault identity cache entry is invalidated. Network errors, Vault 401/403 responses, Graph resource permissions, user cancellation, and other transient failures do not delete it. After a permanent Entra failure, call `setup-vault` in the current agent or restart OpenCode, then authenticate with Microsoft again if Graph tokens also need replacement. Setup responses contain status text only, never secrets.

Windows PowerShell:

```powershell
$cachePath = $env:VAULT_TOKEN_CACHE_PATH
if (-not $cachePath) {
  $base = $env:LOCALAPPDATA
  if (-not $base) { $base = $env:APPDATA }
  if (-not $base) { $base = $HOME }
  $cachePath = Join-Path (Join-Path $base 'm365-mcp') 'vault-token.json'
}
Remove-Item -LiteralPath $cachePath -Force -ErrorAction SilentlyContinue
```

Linux:

```bash
rm -f "${VAULT_TOKEN_CACHE_PATH:-${XDG_CONFIG_HOME:-$HOME/.config}/m365-mcp/vault-token.json}"
```

The code default for `VAULT_SECRET_PATH` remains `outlook-mcp/actsis` for compatibility with existing installations. For the Actsis Vault, set the path explicitly:

```dotenv
VAULT_ADDR=https://vault.edge.actsis.com
VAULT_KV_MOUNT=kv
VAULT_SECRET_PATH=apps/outlook-mcp/prod
VAULT_CUSTOM_HEADER_NAME=X-ACCESS-TOKEN
VAULT_CUSTOM_HEADER_VALUE=replace-with-local-secret
```

Replace `replace-with-local-secret` locally through the process environment, OpenCode secret configuration, or a protected local `.env` file. The header value is sensitive: never commit it, put it in a fixture or release workflow, or embed it in the executable. If either custom-header variable is set without the other, startup fails with `VAULT_CONFIG_INVALID`.

The custom header is sent only on the server-side HTTP requests to Vault: the OIDC authorization URL request, the OIDC callback exchange, token lookup/renewal, and the KV v2 read. Its value is never placed in the OAuth browser URL or sent to the identity provider by the browser. `VAULT_CUSTOM_HEADER_NAME` must be a legal HTTP header token and cannot replace Vault-controlled authentication or namespace headers.

Store the following fields in KV v2 at `kv/data/apps/outlook-mcp/prod` for the Actsis configuration:

```text
MS_CLIENT_ID
MS_CLIENT_SECRET
MS_TENANT_ID
```

The runtime also accepts the existing optional overrides `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `MS_AUTHORITY_HOST`, `MS_SCOPES`, `MS_REDIRECT_URI`, and `MS_TOKEN_ENDPOINT`. Unrelated KV fields are ignored. A least-privilege policy should grant read access only to this secret path:

```hcl
path "kv/data/apps/outlook-mcp/prod" {
  capabilities = ["read"]
}
```

Attach that policy to the `outlook-mcp-developer` OIDC role. Configure the Vault OIDC provider and role according to HashiCorp's [JWT/OIDC API](https://developer.hashicorp.com/vault/api-docs/auth/jwt) and [Azure OIDC provider guide](https://developer.hashicorp.com/vault/docs/auth/jwt/oidc-providers/azuread); use query response mode and the exact localhost callback URI. Do not put an OIDC client secret or a Vault token in this repository.

The runtime precedence is explicit:

1. Parent process and MCP-client environment values win, including intentionally empty values.
2. Vault values override only values that came from the adjacent `.env` file and fill missing runtime values.
3. The adjacent `.env` file fills values not supplied by the process or Vault.
4. An explicit `setup-vault` refresh replaces values previously loaded from Vault without overriding process/MCP-client values.

If `VAULT_ADDR` is unset, Vault is skipped and the existing adjacent `.env`/process-environment behavior remains available. When Vault should provide OAuth values, remove those `MS_*`/`OUTLOOK_*` OAuth keys from the MCP client's environment; process/MCP values intentionally remain authoritative over Vault.

#### Precedence

The server sees MCP-client values and shell/OS values together as `process.env`; it does not distinguish their origin. With Vault enabled, the effective order is:

1. Existing process environment values win. An MCP client's `env` block is passed into `process.env`, so it overrides both Vault and the adjacent `.env` file, including an intentionally empty value.
2. Vault values replace values loaded from the adjacent `.env` and fill missing runtime values.
3. The dispatcher reads the adjacent `.env` and fills only variables not supplied by the process or Vault.
4. If both names in an alias pair are non-empty, `OUTLOOK_CLIENT_ID` wins over `MS_CLIENT_ID`, and `OUTLOOK_CLIENT_SECRET` wins over `MS_CLIENT_SECRET`. The alias fallback uses JavaScript's `||`, so an empty `OUTLOOK_*` value falls back to its `MS_*` alias when that alias is also supplied by the process.

For a packaged executable, `.env` is resolved by the executable's directory, not by the MCP client's working directory. Keep the file beside the downloaded binary.

#### Windows PowerShell

Set variables for the current PowerShell session and start MCP mode:

```powershell
Set-Location 'C:\Tools\outlook-mcp'
$env:OUTLOOK_CLIENT_ID = 'your-application-client-id'
$env:OUTLOOK_CLIENT_SECRET = 'your-client-secret-value'
$env:MS_TENANT_ID = 'your-directory-tenant-id'
& '.\outlook-mcp-win-x64.exe' mcp
```

#### Windows Command Prompt

Set variables for the current Command Prompt session:

```bat
cd /d C:\Tools\outlook-mcp
set "OUTLOOK_CLIENT_ID=your-application-client-id"
set "OUTLOOK_CLIENT_SECRET=your-client-secret-value"
set "MS_TENANT_ID=your-directory-tenant-id"
outlook-mcp-win-x64.exe mcp
```

#### Linux shell

```bash
cd /opt/outlook-mcp
export OUTLOOK_CLIENT_ID='your-application-client-id'
export OUTLOOK_CLIENT_SECRET='your-client-secret-value'
export MS_TENANT_ID='your-directory-tenant-id'
./outlook-mcp-linux-x64 mcp
```

#### `.env` beside the executable

Windows layout and file contents:

```text
C:\Tools\outlook-mcp\outlook-mcp-win-x64.exe
C:\Tools\outlook-mcp\.env
```

```dotenv
# C:\Tools\outlook-mcp\.env
MS_CLIENT_ID=your-application-client-id
MS_CLIENT_SECRET=your-client-secret-value
MS_TENANT_ID=your-directory-tenant-id
```

Run it from any working directory; the file is found beside the executable:

```powershell
& 'C:\Tools\outlook-mcp\outlook-mcp-win-x64.exe' mcp
```

Linux layout and file contents:

```text
/opt/outlook-mcp/outlook-mcp-linux-x64
/opt/outlook-mcp/.env
```

```dotenv
# /opt/outlook-mcp/.env
MS_CLIENT_ID=your-application-client-id
MS_CLIENT_SECRET=your-client-secret-value
MS_TENANT_ID=your-directory-tenant-id
```

Restrict the file to the account that runs the server. On Linux, use `chmod 600 /opt/outlook-mcp/.env`; on Windows, use a user-only ACL for the containing directory and `.env` file.

#### MCP client JSON

An MCP client can pass the same values in its `env` block instead of using `.env`. This Claude Desktop-style example uses the Windows executable; use the Linux path and executable name on Linux:

```json
{
  "mcpServers": {
    "m365-assistant": {
      "command": "C:\\Tools\\outlook-mcp\\outlook-mcp-win-x64.exe",
      "args": ["mcp"],
      "env": {
        "OUTLOOK_CLIENT_ID": "your-application-client-id",
        "OUTLOOK_CLIENT_SECRET": "your-client-secret-value",
        "MS_TENANT_ID": "your-directory-tenant-id"
      }
    }
  }
}
```

The MCP client supplies these values when it starts the process. Do not place a real client secret in a repository, shared configuration sample, issue, or chat transcript.

### Runtime safety and release credentials

- Do not commit `.env`, `.env.*`, token caches, or real credentials. `.env.example` remains intentionally trackable.
- The executable and GitHub Release artifacts are secret-free. The release workflow builds without OAuth variables, scans the artifacts for embedded credentials, and publishes only after the scan passes.
- The inspected workflows use no OAuth client secrets. The release job uses GitHub's built-in `github.token` only to publish the release; it is not a Microsoft credential and is not embedded in the binary.
- Build-time GitHub Actions credentials, if a future maintenance workflow needs them, are CI/release infrastructure credentials. They must never be used as substitutes for the end user's runtime Microsoft Entra values.

The existing npm installation remains supported through `bin/m365-mcp.js`, which bootstraps the same runtime environment as the pre-built executable. Its `.env` lives in the project directory, while a pre-built executable reads `.env` beside the binary. Both paths use the same `OUTLOOK_*`/`MS_*` variables, and `mcp`, `auth`, `vault-setup`, and `http` modes use the same runtime environment.

## What the server can do

| Area                   | Supported operations                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Outlook mail           | List, search, read, draft, send/reply, mark, delete, attachments, and folder moves                                 |
| Calendar               | List, create, decline, cancel, and delete events                                                                   |
| Mail folders and rules | List/create folders, move messages, and list/create/reorder inbox rules                                            |
| OneDrive               | List/search, download URL, small and chunked uploads (text or base64 binary), sharing links, folders, and deletion |
| Power Automate         | List environments and solution-aware flows, run manual-trigger flows, inspect runs, and toggle flows               |

Nested mail-folder paths such as `Parent/Child/Archive` are resolved segment by segment by `create-folder` and `move-emails`. A literal `/` in a folder name is not supported because `/` is always the path separator.

## Tool inventory (49)

### Authentication (6)

| Tool                | Purpose                                                                             |
| ------------------- | ----------------------------------------------------------------------------------- |
| `about`             | Report server identity and supported service areas                                  |
| `authenticate`      | Start the callback server and return the Microsoft Graph browser-authentication URL |
| `setup-vault`       | Run explicit Vault OIDC setup and refresh the current MCP process                   |
| `check-auth-status` | Check and, when possible, refresh **Graph authentication only**                     |
| `authenticate-flow` | Start the callback server and return the separate Power Automate authentication URL |
| `stop-auth-server`  | Stop the callback server started by an authentication tool                          |

### Calendar (5)

| Tool            | Purpose                                          |
| --------------- | ------------------------------------------------ |
| `list-events`   | List upcoming events in an optional date range   |
| `create-event`  | Create an event with optional attendees and body |
| `decline-event` | Decline an event with an optional comment        |
| `cancel-event`  | Cancel an event with an optional comment         |
| `delete-event`  | Delete an event                                  |

### Email (10)

| Tool                  | Purpose                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `list-emails`         | List recent messages in a mail folder                                                                                            |
| `search-emails`       | Search by text, sender, recipient, subject, attachments, or unread state                                                         |
| `read-email`          | Read sanitized visible content; raw HTML is an explicit unsafe debug option                                                      |
| `send-email`          | Send a new message or reply to an existing message, optionally from a shared mailbox with delegation                             |
| `draft-email`         | Create a new draft or reply draft with optional local file attachments, optionally in a shared mailbox with delegation           |
| `forward-draft`       | Create a forward draft quoting the original thread with empty recipients, optionally from a shared mailbox with delegation       |
| `mark-as-read`        | Mark a message read or unread                                                                                                    |
| `delete-email`        | Move a message to Deleted Items or permanently delete it                                                                         |
| `list-attachments`    | List attachment metadata for a message (sizes are Graph server-reported metadata and may differ slightly from the actual binary) |
| `download-attachment` | Return attachment content, optionally decoded when text-like; always reports the exact decoded binary size                       |

### Email signatures (6)

| Tool                          | Purpose                                      |
| ----------------------------- | -------------------------------------------- |
| `create-email-signature`      | Store sanitized HTML and managed CID images  |
| `list-email-signatures`       | List signatures and the shared default       |
| `get-email-signature`         | Read one stored signature                    |
| `update-email-signature`      | Replace a signature's HTML and images        |
| `delete-email-signature`      | Delete a signature and clear it if default   |
| `set-default-email-signature` | Set or clear the default used by email flows |

`send-email`, `draft-email`, and `forward-draft` apply the shared default to new messages and
native reply or forward drafts.
Use `signatureName` for a per-operation override or `includeSignature: false` to opt out. See
[Managed email signatures](docs/email-signatures.md) for CID image, storage, limit, and recovery
details.

### Sending from a shared mailbox

`send-email`, `draft-email`, and `forward-draft` accept an optional `from` parameter with the UPN
or email address of a shared mailbox (e.g. `sac.soporte@actsis.com`), mirroring Outlook's "From"
selector:

- With `from`, requests target `users/{from}/...` Graph endpoints (drafts, replies, native
  reply/attachment/send calls, the forward source-message fetch, and forward drafts included);
  without it, the existing `/me` behavior is unchanged.
- Requires the delegated `Mail.Send.Shared` / `Mail.ReadWrite.Shared` permissions (included in
  the default scope list; re-acquire credentials if your token predates them) **and** an Exchange
  delegation on that mailbox granted to your account: Send As or Send on Behalf for sending,
  Full Access (and a delegate Sent Items rule, if desired) for drafts and replies.
- Exchange enforces the per-user right — the MCP never bypasses it. A missing delegation returns
  a clear `MAILBOX_ACCESS_DENIED` error (Graph HTTP 403) naming the mailbox; there is no silent
  fallback to your own mailbox.
- `replyToId` with `from` must reference a message inside the shared mailbox, as must `forward-draft`'s
  `emailId`; attachments and managed-signature behavior are identical either way.

### Mail folders (3)

| Tool            | Purpose                                                     |
| --------------- | ----------------------------------------------------------- |
| `list-folders`  | List mail folders, optionally including counts and children |
| `create-folder` | Create a folder, optionally below a nested parent path      |
| `move-emails`   | Move comma-separated message IDs to a folder path           |

### Inbox rules (3)

| Tool                 | Purpose                                                        |
| -------------------- | -------------------------------------------------------------- |
| `list-rules`         | List inbox rules, optionally with details                      |
| `create-rule`        | Create a sender/subject/attachment rule with supported actions |
| `edit-rule-sequence` | Change a named rule's execution sequence                       |

### OneDrive (8)

| Tool                     | Purpose                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `onedrive-list`          | List items at a path                                                                  |
| `onedrive-search`        | Search files by name or content                                                       |
| `onedrive-download`      | Get a pre-authenticated download URL by item ID or path (via the `/content` redirect) |
| `onedrive-upload`        | Upload content smaller than 4 MB (text verbatim, or base64 binary)                    |
| `onedrive-upload-large`  | Upload content through a chunked upload session (text or base64 binary)               |
| `onedrive-share`         | Create a view, edit, or embed sharing link                                            |
| `onedrive-create-folder` | Create a folder at a path                                                             |
| `onedrive-delete`        | Delete an item by ID or path                                                          |

### Power Automate (5)

| Tool                     | Purpose                                         |
| ------------------------ | ----------------------------------------------- |
| `flow-list-environments` | List Power Platform environments and their IDs  |
| `flow-list`              | List accessible flows in an environment         |
| `flow-run`               | Trigger a manual flow with optional JSON inputs |
| `flow-list-runs`         | List recent runs for a flow                     |
| `flow-toggle`            | Start or stop a flow                            |

### Teams chats (3)

| Tool                | Purpose                                                                                                                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list-chats`        | List Teams chats (one-on-one and group) for the signed-in user, most recent first; one-on-one ordering probes each chat's newest message because Graph keeps `lastUpdatedDateTime` stale for them (adds a bounded API sweep — tune `CHATS_ACTIVITY_PROBING` / `CHATS_PROBE_CONCURRENCY` in `config.js`) |
| `get-chat-messages` | Read messages from a chat by ID, with optional date-range filtering on message timestamps                                                                                                                                                                                                               |
| `send-chat-message` | Send a plain-text or HTML message to a chat by ID                                                                                                                                                                                                                                                       |

The Teams chat tools use the `Chat.ReadWrite` delegated scope, which is part of the default Graph
scope set. Tokens acquired before this scope was added must be re-acquired: run `npm run auth-server`
and complete the consent flow again (this re-issues Graph credentials; see the shared-file warning
below). The date-range filter on `get-chat-messages` applies `receivedAfter`/`receivedBefore` to the
message `createdDateTime` as a client-side post-filter because Graph does not accept a server-side
`$filter` on that property.

### SharePoint sites (3)

| Tool                 | Purpose                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `list-sites`         | List or search SharePoint team sites accessible to your account                                   |
| `list-site-files`    | List a site's default document library items at a path                                            |
| `download-site-file` | Get a pre-authenticated download URL for a site file (by ID or path, via the `/content` redirect) |

The SharePoint site tools use the `Sites.Read.All` delegated scope and follow the same model as
the shared-mailbox `from` parameter: delegated access only, with access decided per-user by
SharePoint permissions — no application (client-credentials) flow is used. A token acquired
before this scope was added must be re-acquired via `npm run auth-server`. Read access to a site
you do not have gets Graph HTTP 403 as `SITE_ACCESS_DENIED` without a fallback identity.

## Authentication model

`TokenStorage` in `auth/token-storage.js` is the runtime token authority for both APIs. Graph handlers call `ensureAuthenticated()`, while Power Automate handlers call `getValidFlowAccessToken()`. Both token sets share `~/.outlook-mcp-tokens.json`; writes request owner-only mode `0600`. The runtime uses `HOME` first and `USERPROFILE` second to locate that file; these are OS home-directory variables, not OAuth settings that normally belong in `.env`.

Access tokens enter their refresh window five minutes before `expires_at`. Graph refresh is automatic when Graph-backed tools run. Flow refresh is automatic only when both an expired/near-expiry `flow_access_token` and a stored `flow_refresh_token` exist. Initial Flow consent is always separate.

`auth/token-manager.js` is legacy code retained for test-token creation and compatibility. New production paths must use `TokenStorage`.

> **Shared-file warning:** completing Graph authentication writes a new Graph token response directly to the shared file and can remove existing `flow_*` fields. If Power Automate stops authenticating after Graph reauthentication, run `authenticate-flow` again. Do not delete the token file as a first response to a Flow-only problem because that also removes Graph credentials.

For the token lifecycle, failure behavior, and current limitations, read [Authentication](./docs/authentication.md).

## Configuration reference

For the npm path, `bin/m365-mcp.js` loads the project `.env` before starting either mode. For a pre-built executable, the same dispatcher loads `.env` beside the executable. In both paths, existing process environment variables, including values supplied by an MCP client's `env` block, take precedence over file values; see the Vault precedence section when Vault mode is enabled.

| Variable                                 | Consumer                                     | Default / precedence                                | Notes                                                                                                    |
| ---------------------------------------- | -------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `MS_CLIENT_ID`                           | MCP runtime, auth server, and `TokenStorage` | Fallback after `OUTLOOK_CLIENT_ID`                  | Standard `.env` name                                                                                     |
| `MS_CLIENT_SECRET`                       | MCP runtime, auth server, and `TokenStorage` | Fallback after `OUTLOOK_CLIENT_SECRET`              | Use the secret **value**, not its ID                                                                     |
| `OUTLOOK_CLIENT_ID`                      | MCP runtime, auth server, and `TokenStorage` | Preferred over `MS_CLIENT_ID`                       | Convenient for MCP client configuration                                                                  |
| `OUTLOOK_CLIENT_SECRET`                  | MCP runtime, auth server, and `TokenStorage` | Preferred over `MS_CLIENT_SECRET`                   | Convenient for MCP client configuration                                                                  |
| `MS_TENANT_ID`                           | Both                                         | `common`                                            | Use the tenant GUID for single-tenant applications                                                       |
| `MS_AUTHORITY_HOST`                      | Both                                         | `https://login.microsoftonline.com`                 | Trailing slashes are removed                                                                             |
| `MS_SCOPES`                              | Auth server and `TokenStorage`               | Built-in eleven-scope Graph list                    | Space-separated; include `offline_access`                                                                |
| `MS_REDIRECT_URI`                        | Auth server and `TokenStorage`               | `http://localhost:3333/auth/callback`               | Used by initial acquisition and refresh/exchange                                                         |
| `MS_TOKEN_ENDPOINT`                      | Auth server and `TokenStorage`               | Derived v2 token endpoint                           | Used by initial acquisition and refresh/exchange                                                         |
| `USE_TEST_MODE`                          | MCP server                                   | `false`                                             | Enables mocks; see test-mode limitation in the auth guide                                                |
| `ENTRA_TENANT_ID`                        | Remote MCP HTTP mode                         | —                                                   | Tenant GUID for token verification and OBO exchange                                                      |
| `ENTRA_CLIENT_ID`                        | Remote MCP HTTP mode                         | —                                                   | Confidential client for the on-behalf-of exchange                                                        |
| `ENTRA_CLIENT_SECRET`                    | Remote MCP HTTP mode                         | —                                                   | Confidential client secret **value** for OBO exchange                                                    |
| `MCP_HTTP_AUDIENCE`                      | Remote MCP HTTP mode                         | —                                                   | Expected bearer-token audience for this deployment                                                       |
| `MCP_HTTP_REQUIRED_SCOPES`               | Remote MCP HTTP mode                         | —                                                   | Non-empty delegated scope(s) every token must carry                                                      |
| `MCP_HTTP_PORT` / `MCP_HTTP_HOST`        | Remote MCP HTTP mode                         | `3000` / `127.0.0.1`                                | Listener; non-loopback binds require TLS                                                                 |
| `MCP_HTTP_ALLOW_LOCAL_HTTP`              | Remote MCP HTTP mode                         | —                                                   | Local development only: exactly `true` opts into plaintext loopback HTTP (Compose config sets it itself) |
| `MCP_HTTP_TLS_CERT` / `MCP_HTTP_TLS_KEY` | Remote MCP HTTP mode                         | —                                                   | PEM paths for a direct HTTPS listener                                                                    |
| `MCP_HTTP_ALLOWED_ORIGINS`               | Remote MCP HTTP mode                         | _(deny Origin)_                                     | Comma-separated accepted browser origins                                                                 |
| `MCP_HTTP_EXTERNAL_BASE_URL`             | Remote MCP HTTP mode                         | _(listener host/port; required for wildcard binds)_ | Public base URL in discovery metadata                                                                    |

The standalone auth server always listens on port `3333`; there is no environment-variable port override.

## Other MCP clients

Use the same absolute `node /path/to/outlook-mcp/bin/m365-mcp.js` command and environment values:

```toml
# ~/.codex/config.toml
[mcp_servers.m365-assistant]
command = "node"
args = ["/absolute/path/to/outlook-mcp/bin/m365-mcp.js", "mcp"]

[mcp_servers.m365-assistant.env]
OUTLOOK_CLIENT_ID = "your-application-client-id"
OUTLOOK_CLIENT_SECRET = "your-client-secret-value"
MS_TENANT_ID = "your-directory-tenant-id"
```

OpenCode uses a command array instead:

The environment block needs only non-secret Vault connection settings and the
protected gateway header. It intentionally contains no Microsoft OAuth values
and no `VAULT_TOKEN`; the OIDC token is cached locally after the first login.

```jsonc
{
  "mcp": {
    "m365-assistant": {
      "type": "local",
      "command": ["node", "/absolute/path/to/outlook-mcp/bin/m365-mcp.js"],
      "args": ["mcp"],
      "enabled": true,
      "environment": {
        "VAULT_ADDR": "https://vault.edge.actsis.com",
        "VAULT_AUTH_MOUNT": "oidc",
        "VAULT_ROLE": "outlook-mcp-developer",
        "VAULT_OIDC_PORT": "8250",
        "VAULT_KV_MOUNT": "kv",
        "VAULT_SECRET_PATH": "apps/outlook-mcp/prod",
        "VAULT_CUSTOM_HEADER_NAME": "X-ACCESS-TOKEN",
        "VAULT_CUSTOM_HEADER_VALUE": "replace-with-local-secret",
      },
    },
  },
}
```

Replace the custom-header placeholder locally with the protected secret value. Keep it in OpenCode's local secret configuration, the process environment, or a protected local `.env`; do not commit it or embed it in the executable. The value is used only for Vault API requests and is not included in the OAuth browser URL.

## Troubleshooting

### Microsoft Graph (Outlook, calendar, rules, and OneDrive)

| Symptom                                                                 | Recovery                                                                                                                      |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `Authentication required` or `check-auth-status` says not authenticated | Call `authenticate`, open its URL, and complete Graph consent; the callback server starts automatically                       |
| Graph returns `UNAUTHORIZED` (HTTP 401)                                 | The API rejected the submitted token; complete Graph authentication again because a 401 does not force local invalidation     |
| Graph returns HTTP 403 in an API error                                  | Authentication may be valid but the account/app lacks the required delegated permission; verify Entra permissions and consent |
| `AADSTS7000215` / invalid client secret                                 | Configure the client secret **value**, not the secret ID                                                                      |
| `self-signed certificate in certificate chain`                          | Read the operation/target first; inspect system/proxy TLS trust before treating it as a Vault failure                         |
| OAuth state is invalid or expired                                       | Start again from `authenticate`; pending state expires after ten minutes and is single-use                                    |
| Port 3333 is already in use                                             | Stop the existing process, or run `npx kill-port 3333`, then call `authenticate` again                                        |

### Power Automate

| Symptom                                           | Recovery                                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Flow authentication required                      | Call `authenticate-flow`; `check-auth-status` does not inspect Flow credentials                                       |
| `FLOW_UNAUTHORIZED` (HTTP 401)                    | The API rejected the submitted token; complete `authenticate-flow` again because a 401 does not invalidate it locally |
| `FLOW_FORBIDDEN` / HTTP 403                       | Verify Power Automate access, ownership/editor rights, environment and flow IDs, and that the flow is solution-aware  |
| A flow cannot be triggered                        | `flow-run` supports the manual trigger endpoint only; verify the flow is enabled and has a manual trigger             |
| Flow stopped working after Graph reauthentication | Graph acquisition may have removed `flow_*` from the shared file; call `authenticate-flow` again                      |

See [Power Automate troubleshooting](./docs/power-automate.md#errors-and-recovery) for the service-specific workflow.

## Development

```bash
npm run inspect       # MCP Inspector
npm run test-mode     # server with mock Graph/Flow responses
npm test              # Jest
npm run lint          # ESLint
npm run format:check  # Prettier check
```

The active server entry point is `index.js`; the active browser callback server is `outlook-auth-server.js`. Contributor architecture and verification guidance live in [`CLAUDE.md`](./CLAUDE.md).

## Credits and license

Built on [ryaker/outlook-mcp](https://github.com/ryaker/outlook-mcp) by [ryaker](https://github.com/ryaker). Licensed under [MIT](./LICENSE) © 2026 Ricardo Pinto; the original work is also MIT licensed.
