# Remote Authentication Specification

## Purpose

Define the user-visible authentication contract of the intranet MCP HTTP listener (`remote/http-server.js`): the explicit authentication-mode selector between direct Entra (optional, unchanged) and the chosen persistent bridge flow with server-held delegated renewal and durable encrypted persistence, the per-mode discovery and challenge metadata, and the stateless bearer-validation boundary shared by both modes. Local stdio-mode authentication requirements live in [`../auth/spec.md`](../auth/spec.md); token lifecycle lives in [`../flow-token-management/spec.md`](../flow-token-management/spec.md).

## Requirements

### Requirement: Authentication Mode Selection

The listener MUST accept an explicit `MCP_HTTP_AUTH_MODE` selector with exactly the values `entra` (direct Entra authorization-server mode, optional) or `bridge` (the chosen persistent service-owned standards OAuth sign-in flow); any other value MUST refuse startup. Without the selector, the previous automatic behavior MUST be preserved unchanged: bridge exactly when the bridge browser-callback configuration is set, direct Entra otherwise. Explicit `entra` MUST ignore the bridge-only settings (browser callback URL, pre-registered external clients, supported client scopes, dynamic registration, bridge store configuration) while every ordinary shared validation (tenant GUID, client credentials, audience, required scopes) stays enforced, and explicit `bridge` MUST require the complete bridge configuration exactly as the automatic selection validates it. No separate per-agent Entra application registration is required for the bridge.

#### Scenario: Explicit direct mode despite legacy bridge settings

- GIVEN `MCP_HTTP_AUTH_MODE=entra` and the legacy bridge-only settings are set
- WHEN the configuration resolves
- THEN the listener runs direct Entra mode with no bridge OAuth configuration
- AND malformed or unwanted legacy bridge values are never parsed

#### Scenario: Explicit direct mode does not weaken shared validation

- GIVEN `MCP_HTTP_AUTH_MODE=entra`
- WHEN the tenant is not a GUID, the required scopes carry an API-qualified URI, or the audience override is empty
- THEN startup is refused with the ordinary validation error for that key

#### Scenario: Explicit bridge without a complete configuration

- GIVEN `MCP_HTTP_AUTH_MODE=bridge` without a browser callback URL, or without any pre-registered client and dynamic registration
- WHEN the configuration resolves
- THEN startup is refused naming the mode and the missing bridge configuration

### Requirement: Direct-Entra Discovery and Challenges

In direct Entra mode, the protected-resource discovery document MUST advertise the tenant Entra issuer as the only authorization server, and MUST advertise the fully resource-qualified Entra request scopes derived with the configured derivation (the configured resource-qualified upstream scopes when set, otherwise `api://<client id>/<required short scope>`). The RFC 9728 `WWW-Authenticate` challenge in direct mode MUST carry the same resource-qualified scopes in its `scope` attribute. The discovery `resource` field MUST stay this deployment's canonical base URL and MUST NOT be rewritten into an `api://` URI; internal token verification MUST keep requiring the short scp scope names.

#### Scenario: Direct-mode discovery exposes only Entra with qualified scopes

- GIVEN a direct-Entra deployment
- WHEN a client fetches `/.well-known/oauth-protected-resource`
- THEN `authorization_servers` contains only the configured tenant Entra issuer
- AND `scopes_supported` lists the resource-qualified request scopes and not the short scp names
- AND `resource` is the canonical deployment URL

#### Scenario: Direct-mode 401 challenge names the qualified scope

- GIVEN a direct-Entra deployment
- WHEN an unauthenticated request reaches `/mcp`
- THEN the 401 challenge contains `scope="` followed by the resource-qualified scope list
- AND the `resource_metadata` URL remains the canonical deployment URL

### Requirement: Bridge Metadata

In bridge mode, the protected-resource discovery document and the `WWW-Authenticate` challenge MUST stay exactly as previously advertised (the service issuer first, the tenant Entra issuer second, the merged short-and-client scopes), so pre-existing clients keep their behavior. The service authorization-server metadata MUST additionally advertise the rotating refresh-token grant the provider implements (authorization-code plus refresh-token), while revocation stays unimplemented and unadvertised.

#### Scenario: Bridge discovery is unchanged

- GIVEN a bridge deployment with configured external clients
- WHEN a client fetches `/.well-known/oauth-protected-resource`
- THEN `authorization_servers` is the service OAuth issuer followed by the tenant Entra issuer
- AND `scopes_supported` merges the required short scp scopes with the client scopes as before

### Requirement: Persistent Bridge Runtime Renewal and Durable Store

In bridge mode the runtime MUST create exactly one encrypted durable store at HTTP startup, bound by an authenticated deployment identifier carrying the canonical service base URL plus the tenant and client identifiers (never the app secret, and a store moved to a different binding MUST fail closed without reset), select its directory from `MCP_HTTP_BRIDGE_STORE_DIR` (defaulting the CLI bridge to the platform state directory `~/.outlook-mcp/remote-oauth`) with the optional separate `MCP_HTTP_BRIDGE_KEY_FILE`, close it on shutdown, and MUST NOT create any store in direct Entra mode; programmatic deployments without an explicit store stay in-memory so test fixtures never write real key material. The runtime MUST wire the upstream renewal through the dedicated bounded refresh service (`remote/entra-refresh.js`) that reuses the safe bounded HTTP conventions (tenant-pinned HTTPS endpoint, `grant_type=refresh_token` with the resource-qualified upstream scopes plus `offline_access`, <= 30 second timeout, bounded responses, no resource/audience fabrication, client secret server-side, no token or error body in errors), and MUST return the initial sign-in's upstream refresh credential server-side only. The renewed upstream access token MUST be verified with the same existing Entra verifier (signature, issuer, configured MCP audience, tenant, expiry, delegated scopes) and the immutable delegated `oid`/`tid` identity before binding, and a rotated upstream refresh credential MUST be stored when returned while the previous one is retained when it is not. `/mcp` MUST renew a stale upstream credential through this seam under a per-family singleflight (every follower sharing the leader's outcome, never surfacing a stale expired-token success), answer `503` with a generic retryable error for transient renewal failures (no unauthorized fallback token, no dispatch), and answer `401` and permanently persist only the affected family's revocation when the renewal fails for a genuine user-consent reauth condition (`invalid_grant`, `interaction_required`, `consent_required`, `login_required`) or the renewed credential fails verification or the identity binding; client/configuration failures and any other response class MUST never wipe stored grants, and revocation MUST be irreversible after the inflight completes.

#### Scenario: Expired upstream renews inside a still-valid MCP grant

- GIVEN a bridge family whose MCP token is valid but whose upstream credential expired
- WHEN an authenticated `/mcp` request arrives
- THEN the server renews exactly once per family through the tenant-pinned refresh grant carrying the upstream qualified scopes and `offline_access`, verifies and binds the renewed credential to the same user, and dispatches the tool with the renewed on-behalf-of credential (never the MCP token)

#### Scenario: Renewal outage answers 503 without data loss

- GIVEN the upstream refresh endpoint is transiently unreachable
- WHEN an authenticated `/mcp` request arrives with a valid MCP token and an expired upstream credential
- THEN the request answers `503` with a generic retryable error, every stored grant stays untouched, no tool runs, and a later request retries the renewal

#### Scenario: Permanent reauth invalidates only the family

- GIVEN Microsoft answered a genuine user-consent reauth condition, or the renewed credential fails the deployment verifier or the immutable identity binding
- WHEN the renewal completes
- THEN `/mcp` refuses with `401`, the family's revocation is persisted (a fresh process on the same store stays refused), and unrelated families keep working

#### Scenario: The durable store follows the right deployment only

- GIVEN a bridge store created for one canonical base URL, tenant, and client
- WHEN a listener with a different binding loads the same directory
- THEN startup fails closed with the store's unauthorized error and the store is never reset or overwritten

#### Scenario: Direct mode creates no store

- GIVEN an explicit direct-Entra deployment
- WHEN the listener starts
- THEN bridge store configuration is ignored, no store exists, and MCP clients keep their own refresh tokens client-side

### Requirement: Bridge Refresh-Token Families and Service-Side Persistence

In bridge mode, the authorization server MUST issue one-time rotating refresh tokens bound to client, delegated user, resource, and scopes for every registered client unless that client's registration explicitly restricts its grants to the authorization-code grant, and MUST NOT issue a refresh token in any other case. A correctly-bound replay of a consumed refresh token MUST revoke exactly that family's access and refresh tokens while unrelated grants keep working; unknown, cross-client, wrong-resource, and expanding-scope refresh requests MUST fail with the standard errors and leave all stored state unchanged. Refresh families MUST expire under a finite bounded sliding TTL with the 90-day default bounded at most 365 days, and - when an injectable persistent store is configured - every staged state change MUST be committed as a whole encrypted snapshot BEFORE it is published to memory or returned, loading once at startup with fail-closed validation, while pending browser authorizations and authorization codes stay transient. The upstream Entra credential MUST be renewed by the server through the tenant-pinned confidential-client refresh grant; the credential shape validation stays in the provider, which never performs network Entra work itself.

#### Scenario: Rotation and replay revocation

- GIVEN a client whose registration does not restrict grants
- WHEN it exchanges its code and then its refresh token
- THEN each redemption rotates the refresh token one-time within the same family, and reusing a consumed token (including two concurrent presentations of the same token) is answered with `invalid_grant` after that family's access and refresh tokens were revoked without touching any other user's grants, and no second still-valid rotation is ever minted

#### Scenario: Refusals mutate nothing

- GIVEN an unknown, cross-client, wrong-resource, or scope-expanding refresh request
- WHEN it reaches the token endpoint
- THEN it receives the exact standard OAuth error and afterwards the legitimate owner can still rotate immediately

#### Scenario: Persisted credentials survive a restart

- GIVEN a provider configured with the bridge-store persistent store that issued access and refresh tokens
- WHEN a fresh provider instance loads the same snapshot
- THEN the same MCP access token verifies and the same refresh token continues its rotating family, while no plaintext MCP token or pending authorization code or browser state is recoverable from the snapshot

### Requirement: Stateless Bearer Validation Boundary

The listener MUST validate one delegated Entra bearer token per request (signature, issuer, audience, tenant, expiry, delegated identity, required short scp scopes) with no server-side session or persisted user refresh tokens, and a still-valid token MUST be accepted by a recreated server process. Unauthenticated, expired, wrong-audience, wrong-tenant, and insufficient-scope requests MUST get `401` with the discovery metadata before any dispatch, and tokens for two distinct users MUST stay isolated per request.

#### Scenario: Still-valid token survives server recreation

- GIVEN a delegated bearer token that verifies for the deployment
- WHEN the listener stops and an identically configured listener starts
- THEN a request with that same token is served normally

#### Scenario: Rejected tokens never dispatch

- GIVEN requests carrying no token, an expired token, a token for another audience, or a token without the required scope
- WHEN they reach `/mcp`
- THEN every one is answered with 401 and no tool dispatch or on-behalf-of exchange runs
