# Bridge OAuth persistence and refresh-token families

One encrypted, crash-safe file now survives Docker restarts for the service-owned OAuth bridge, so a signed-in user keeps their MCP session (and their rotating refresh-token family) when the MCP HTTP container restarts. This document covers the T17 store module (`remote/bridge-store.js`) and the T18 provider integration (`remote/oauth-provider.js`).

**Status: wired and active in the bridge runtime (T19).** The bridge mode of `remote/http-server.js` creates the store itself at HTTP runtime startup (`MCP_HTTP_BRIDGE_STORE_DIR`, default `~/.outlook-mcp/remote-oauth` on the CLI, `direct`-Entra mode never creates one), binds it to the deployment (canonical service URL + tenant + client IDs via the authenticated `deploymentId`), injects the encrypted `persistentStore` and the real upstream renewal callback into the provider, and closes the store on shutdown.

## Runtime wiring (T19)

| Topic             | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Store creation    | Bridge mode creates exactly one `createBridgeStore` instance at listener startup, bound to `bridgeDeploymentId = <canonical origin>                                                                                                                                                                                                                                                                                                                                            | <tenantId> | <clientId>` (no app secret). A store moved to a different canonical URL, tenant, or client fails closed (`BRIDGE_STORE_UNAUTHORIZED`) instead of being reset. Direct Entra mode creates no store. |
| Storage location  | `MCP_HTTP_BRIDGE_STORE_DIR` when set; otherwise the CLI bridge defaults to `~/.outlook-mcp/remote-oauth` (container deployments set `/app/data/oauth` through the Compose volume, handled by T20). Programmatic test defaults stay in-memory: no store is created unless an explicit directory or injected store is given, so test fixtures never write real key material to the user's home.                                                                                  |
| Key               | `MCP_HTTP_BRIDGE_KEY_FILE` selects an external, already-mounted 32-byte key file; otherwise a private key is auto-generated inside the store directory. Back up the key and the ciphertext together, restrict access, and run exactly one replica.                                                                                                                                                                                                                             |
| Renewal callback  | Wired by default to the dedicated `remote/entra-refresh.js` service: tenant-pinned HTTPS `grant_type=refresh_token`, resource-qualified upstream scopes plus `offline_access`, bounded response/timeout (<= 30 s), secrets redacted from every error. An injected `oauth.refreshUpstreamEntraToken` replaces it in tests.                                                                                                                                                      |
| Re-auth semantics | Only Microsoft's own user-consent conditions (`invalid_grant`, `interaction_required`, `consent_required`, `login_required`) or a renewed credential failing the same Entra verifier / immutable `oid`+`tid` binding permanently invalidate the family (persisted revocation, no resurrection). `invalid_client`/configuration failures and network/5xx/malformed responses are service/transient errors: grants stay intact and `/mcp` answers `503 temporarily_unavailable`. |
| TTL               | `refreshTokenTtlSeconds` keeps its 90-day default; the cap is tightened to **365 days** (the previous ten-year cap was too generous). No new environment knob was added.                                                                                                                                                                                                                                                                                                       |

## Docker deployment (T20)

Compose mounts a project-scoped named volume at `/app/data/oauth` and sets `MCP_HTTP_BRIDGE_STORE_DIR` to that path for both `compose.yaml` (TLS, production-shaped) and `compose.local.yaml` (explicitly local, plaintext, with `MCP_HTTP_AUTH_MODE=bridge` forced on). The image prepares the directory empty (uid 1000, mode 0700); a fresh first mount inherits that ownership; no key is generated at build time.

| Rule                | What is true                                                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Initial login       | Each user's first sign-in must be a **fresh** one: it requests `offline_access` exactly once so the bridge can hold the encrypted upstream Entra refresh credential server-side; the MCP client keeps its own rotating MCP refresh token and never sees the Entra credential.                                      |
| Restarts            | Sessions and refresh families survive container recreation and listener restarts through the volume, and rotate on demand. A lost volume or lost key is **not recoverable** — grants are never blanked or guessed; every user repeats the Microsoft sign-in.                                                       |
| Never wipe          | Do **not** run `docker compose down -v` (or `docker volume rm`) against the deployment unless losing every stored grant is intended. `down` alone keeps the volume.                                                                                                                                                |
| Backups             | Back the store contents up: the encrypted `bridge-store.bin` and its `bridge-store.key` together, protected like credential material; one without the other is useless.                                                                                                                                            |
| Single replica      | Both Compose files pin `deploy.replicas: 1`. The store still has **no distributed lock** — exactly one live store replica per directory remains an operator invariant that the pin documents, not a distributed guarantee: two live writers on one directory can still conflict (`BRIDGE_STORE_CONCURRENT_WRITE`). |
| Not perpetual login | The upstream `offline_access` refresh credential itself expires and can require re-consent; no perpetual-login guarantee exists.                                                                                                                                                                                   |

## Quick path

1. Configure the provider with a durable store:

   ```js
   const { createMCPOAuthProvider } = require('../remote/oauth-provider');
   const { createBridgeStore } = require('../remote/bridge-store');

   const bundle = createMCPOAuthProvider({
     // ... issuerUrl, signInUrl, supportedScopes, clients ...
     persistentStore: createBridgeStore({
       directory: '/data/bridge', // dedicated; holds bridge-store.bin + key
       keyFile: '/secrets/bridge.key', // or key: 32-byte Buffer
       deploymentId: 'm365-local-dev', // non-secret, authenticated binding
     }),
     refreshTokenTtlSeconds: 90 * 24 * 60 * 60, // default; finite, sliding
     refreshUpstreamEntraToken: async ({ upstream, identity }) => {
       // T19 injects the real Entra renewal here; never implemented inline
       // by the provider.
       return { accessToken, expiresAt }; // + optional refreshToken passed through
     },
   });
   ```

2. The provider loads once at creation and commits every state change as a whole snapshot **before** it is published to memory or returned to a client. A failed commit returns no tokens and leaves both disk and memory untouched.
3. Fail-closed codes to treat as operational incidents, never as recoverable by blanking: `BRIDGE_STORE_KEY_MISSING`, `BRIDGE_STORE_UNAUTHORIZED`, `BRIDGE_STORE_FORMAT_INVALID`, `BRIDGE_STORE_VERSION_UNSUPPORTED`, `BRIDGE_STORE_STORE_TOO_LARGE`, `BRIDGE_STORE_CONCURRENT_WRITE`, and provider-side `mcp-oauth-persisted-state-invalid`.

## Provider behavior (T18)

| Topic           | Decision                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refresh grant   | Advertised in metadata. Every registered client gets a one-time rotating refresh token by default; a registration that sets `grants: ['authorization_code']` never receives one. Dynamic registrations never receive one.                                                                                                                                                                                                    |
| Families        | Each sign-in binds one family to the client, delegated user identity, resource, scopes, and the validated upstream Entra credential. Rotation and revocation respect these strict bindings; unknown, cross-client, wrong-resource, and invalid-scope refresh requests fail closed **without mutating any state** (no cross-client revoke DoS).                                                                               |
| Rotation        | One-time: each refresh consumes its token, tombstones it for the remaining sliding TTL window, and issues a fresh access + refresh token. Scopes may narrow, never expand. A correctly-bound replay of a consumed token revokes exactly that family (all its access and refresh tokens); unrelated grants stay intact. Tombstones are pruned only after their window expires, so a consumed token can never be reintroduced. |
| Expiry          | `refreshTokenTtlSeconds` is a finite, strictly positive, bounded sliding TTL (default 90 days, capped at 365 days since T19 — the previous ten-year cap was tightened). The window slides on each successful rotation; access tokens stay governed only by their own TTL.                                                                                                                                                    |
| Persistence     | Snapshot fields: families, hash-keyed access/refresh tokens and tombstones (`at:`/`rt:` + SHA-256 — no plaintext opaque MCP token ever reaches the snapshot), optional dynamic client registrations, and the upstream credential inside the encrypted envelope. Pending browser authorizations and authorization codes stay **transient**: a restart only loses sign-ins that were in progress and must be repeated.         |
| Dynamic clients | Persisted when dynamic registration is enabled alongside a store; restored on restart. A snapshot with persisted dynamic clients that loads into a configuration without dynamic registration fails closed honestly.                                                                                                                                                                                                         |
| Validation      | Loaded snapshots (and staged commits) validate versions, exact field sets, prototype-pollution keys (`__proto__`/`constructor`/`prototype`), bounded expiries, map caps, and reference consistency. Anything else fails closed with `mcp-oauth-persisted-state-invalid`.                                                                                                                                                     |

## Upstream renewal seam (wired; the runtime default is real)

The provider never performs network Entra work itself. It exposes `bundle.ensureUpstreamEntraToken(mcpToken)`: it resolves the validated upstream association for a still-valid MCP token and, when the upstream credential is expired or inside the 5-minute renewal window, calls the injected callback **once per family** (singleflight; commits before anything is observable; every concurrent follower shares the leader's success or exact error, so no follower can surface a stale expired-token success). The stored identity is immutable by construction: whatever the callback returns for identity fields is ignored, and only the credential shape (`accessToken`, `expiresAt`, optional rotated `refreshToken`) is validated.

- **Callback missing + stale upstream**: undefined — `/mcp` keeps failing closed exactly as before (no fake refresh credential exists).
- **Callback throws `error.code = 'PERMANENT_UPSTREAM_REAUTH_REQUIRED'`** (exported as `UPSTREAM_REAUTH_REQUIRED`): the family is **persisted revoked** before the failure is observable, `/mcp` answers `401`, the refresh grant answers `invalid_grant`, and the family cannot be resurrected; the user must repeat the Microsoft sign-in.
- **Any other callback rejection**: transient — safe error, stored state untouched, the family is retried later, and `/mcp` answers `503 temporarily_unavailable` in the runtime wiring.
- **Rotated `refreshToken`**: when the callback returns a valid rotated refresh credential it replaces the stored one; without one the previous credential is retained (a granted refresh capability is never silently dropped). A malformed rotation is dropped, never stored or returned.
- **Initial sign-in refresh**: the upstream sign-in requests `offline_access` exactly once (with the resource-qualified API scope, `openid`, and `profile`), and `completeLoginWithUpstream` passes a strictly-shaped `upstream.refreshToken` server-side only; when Microsoft issues none the bridge records no pretended grant and the family becomes reauth-only at expiry.

## Store details (T17, unchanged)

| Topic            | Decision                                                                                                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Encryption       | The **entire snapshot** with AES-256-GCM, one fresh 96-bit nonce per commit, AAD-bound to format version, generation, and the non-secret `deploymentId`.                                                                                                                                       |
| Key management   | Exactly one of: explicit 32-byte Buffer, an existing external `keyFile` (never created/rewritten by the store), or auto-generation at `<directory>/bridge-store.key`. Never derived from a client secret; missing key beside an existing store fails `BRIDGE_STORE_KEY_MISSING` — no blanking. |
| Crash safety     | Temp file (0600) in the same directory, `fsync`, atomic rename, directory fsync where supported. Failures before rename leave the previous snapshot durable and remove the temp file.                                                                                                          |
| Generations      | Monotonic, AAD-authenticated generation; the store fails `BRIDGE_STORE_CONCURRENT_WRITE` instead of clobbering a newer snapshot.                                                                                                                                                               |
| Modes and errors | Data and key files 0600, directory 0700 on POSIX. Error text is code-and-operation only — never token material.                                                                                                                                                                                |

## Explicit concurrency boundary (documented, not hidden)

Still a **single-replica** store: exactly one store replica per directory (a deployment concern for the Compose work). Inside one process the synchronous store interface serializes commits, and the generation check fails closed against another writer, but two concurrently running writers on the same directory can still race between the header read and the rename.

## Checklist

- [x] The runtime wiring injects both `persistentStore` (from `MCP_HTTP_BRIDGE_STORE_DIR`/`MCP_HTTP_BRIDGE_KEY_FILE`) and the real `refreshUpstreamEntraToken` renewal into the bridge provider; direct mode creates no store.
- [x] Programmatic/test deployments isolate all store writes in temporary directories; the CLI bridge persists at the explicit or platform-default path.
- [x] Exactly one replica mounts each store directory: both Compose files pin `deploy.replicas: 1` and document the honest boundary — the single-node store still has no distributed lock, so the pin is deployment guidance, not a store-level guarantee.
- [x] `deploymentId` is stable per deployed environment (canonical service URL + tenant + client, no app secret); the Compose volume `/app/data/oauth` keeps the key inside the volume next to the ciphertext, so both are backed up together and a volume loss is honestly unrecoverable (T20).

## Threat model (new surfaces)

| Threat                                                            | Mitigation                                                                                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Host or volume reader steals MCP or upstream credentials          | Whole snapshot encrypted at rest; MCP tokens appear only as prefixed SHA-256 map keys.                                           |
| Stolen MCP refresh token replayed                                 | One-time rotation + tombstoned replay detection revoking exactly that family.                                                    |
| Attacker revokes another user's grant via malformed refresh calls | Strict client/resource/scope binding: unknown/cross-client/wrong-scope/invalid-resource requests mutate nothing.                 |
| Corrupt or tampered snapshot after a crash                        | Fail-closed validation and GCM authentication; restart refuses to start with lost or damaged state instead of silently blanking. |
