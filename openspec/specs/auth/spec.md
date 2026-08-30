# Authentication Specification

## Purpose

Define the productive Microsoft Graph OAuth flow, Graph token refresh, authentication status, and the boundary between the current `TokenStorage` implementation and the legacy `token-manager` compatibility module. Power Automate token lifecycle requirements live in [`../flow-token-management/spec.md`](../flow-token-management/spec.md).

## Requirements

### Requirement: Productive OAuth Server

The productive authentication process MUST be `outlook-auth-server.js`, started through `npm run auth-server`, and MUST expose Graph authorization, Flow authorization, and the shared callback on port 3333.

#### Scenario: Graph authentication URL is requested

- GIVEN the productive auth server has `MS_CLIENT_ID` and `MS_CLIENT_SECRET`
- WHEN a client requests `GET /auth`
- THEN the server MUST redirect to the configured Microsoft identity authority
- AND the request MUST include the Graph scopes from `config.AUTH_CONFIG.scopes`, the configured callback URI, and a cryptographically random `state`

#### Scenario: Required credentials are absent

- GIVEN either `MS_CLIENT_ID` or `MS_CLIENT_SECRET` is absent
- WHEN a client requests `GET /auth` or `GET /auth/flow`
- THEN the server MUST respond with HTTP 500
- AND the response MUST explain which credentials are required

### Requirement: Vault Bootstrap and Explicit Setup

When Vault mode is enabled, ordinary MCP startup MUST use an explicit
`VAULT_TOKEN` or a valid per-user Vault token cache. It MUST NOT start the
Vault OIDC browser flow because the cache is missing, stale, or unusable.
The MCP server MUST remain available in a setup-required state so the agent
can invoke the explicit `setup-vault` tool.

#### Scenario: Vault cache is valid

- GIVEN Vault mode is enabled and the per-user cache contains a valid token
- WHEN normal MCP startup loads the runtime environment
- THEN it MUST validate/renew the cached token and read the allowlisted KV values
- AND it MUST NOT open a browser

#### Scenario: Vault cache is missing or unusable

- GIVEN Vault mode is enabled without `VAULT_TOKEN`
- AND the cache is missing, expired, or rejected by Vault lookup/KV access with HTTP 401 or 403
- WHEN normal MCP startup loads the runtime environment
- THEN it MUST not start OIDC or delete the cache entry
- AND it MUST start in a setup-required state

#### Scenario: Vault has a transient or configuration failure

- GIVEN Vault lookup, KV access, or cache coordination fails with a network, timeout, gateway, or configuration error
- WHEN normal MCP startup loads the runtime environment
- THEN it MUST preserve the cache
- AND it MUST surface the safe hard failure where startup cannot safely continue

#### Scenario: Explicit Vault setup is requested

- GIVEN Vault mode is enabled without an explicit `VAULT_TOKEN`
- WHEN `setup-vault` is invoked
- THEN it MUST bypass the inherited bootstrap marker and force the Vault OIDC flow
- AND it MUST save only the Vault token and lease metadata after KV loading succeeds
- AND it MUST apply only allowlisted KV values and refresh the current configuration and `TokenStorage` singleton
- AND it MUST return status text without tokens or KV values

#### Scenario: Explicit Vault token is configured

- GIVEN `VAULT_TOKEN` is configured
- WHEN normal startup or `setup-vault` loads Vault values
- THEN it MUST use that token without starting OIDC
- AND it MUST NOT read or write the Vault token cache

#### Scenario: Vault setup is disabled

- GIVEN `VAULT_ADDR` is not configured
- WHEN `setup-vault` is invoked
- THEN it MUST return an actionable setup message
- AND it MUST NOT open a browser

#### Scenario: Setup replaces prior Vault-loaded values

- GIVEN the current process previously loaded values from Vault
- AND process/MCP environment credentials remain configured
- WHEN `setup-vault` successfully loads a new Vault identity
- THEN new Vault-loaded values MUST replace the previous Vault-loaded values
- AND process/MCP values MUST remain authoritative

### Requirement: Permanent Entra Failure Cache Invalidation

The active Microsoft token acquisition and Graph refresh boundaries MUST use
the same typed classifier for permanent Entra OAuth failures. Only a
permanent token-endpoint rejection such as `invalid_grant`, `invalid_client`,
`unauthorized_client`, or an equivalent permanent AADSTS response MAY
invalidate the matching Vault identity cache entry. The invalidation MUST be
per-identity and serialized with cache setup/validation.

#### Scenario: Permanent Entra OAuth failure

- GIVEN the active callback exchange or Graph refresh receives a permanent Entra OAuth rejection
- WHEN the failure is classified
- THEN it MUST invalidate only the configured Vault identity cache entry
- AND it MUST not log token contents

#### Scenario: Non-permanent or unrelated failure

- GIVEN the failure is a network, timeout, parse, save, Vault authorization, Graph resource permission, user cancellation, or transient gateway failure
- WHEN the failure is classified
- THEN it MUST NOT invalidate the Vault identity cache

### Requirement: Graph Scope Configuration

Productive Graph authorization MUST use `config.AUTH_CONFIG.scopes`. The scope list MUST contain `offline_access` and the delegated scopes required by the registered Graph tools.

#### Scenario: Productive Graph scopes are constructed

- GIVEN `config.AUTH_CONFIG.scopes`
- WHEN `outlook-auth-server.js` constructs the Graph authorization URL and code-exchange request
- THEN both requests MUST use that scope list
- AND the list MUST contain `offline_access`, `User.Read`, mail, calendar, contacts, and files permissions

#### Scenario: TokenStorage uses its configured Graph scopes

- GIVEN a `TokenStorage` instance
- WHEN it constructs a Graph refresh or direct code-exchange request
- THEN it MUST use `MS_SCOPES` when that environment variable is set
- AND otherwise it MUST default to `config.AUTH_CONFIG.scopes`

### Requirement: Callback Intent Is Bound to OAuth State

The shared `GET /auth/callback` route MUST determine whether a callback belongs to Graph or Flow from server-side metadata stored for the OAuth `state`. It MUST NOT infer intent from the token response scope.

#### Scenario: Flow callback is routed by state metadata

- GIVEN `/auth/flow` stored `{ flow: true }` for a generated state
- WHEN `/auth/callback` receives that valid state and an authorization code
- THEN the server MUST exchange the code as a Flow authorization
- AND it MUST persist the result through `TokenStorage.saveFlowTokens()`
- AND it MUST preserve existing Graph keys

#### Scenario: Graph callback is routed by state metadata

- GIVEN `/auth` stored `{ flow: false }` for a generated state
- WHEN `/auth/callback` receives that valid state and an authorization code
- THEN the server MUST exchange the code as a Graph authorization
- AND it MUST render the Graph authentication result

#### Scenario: Callback state is invalid or expired

- GIVEN a callback with a missing or unknown `state`
- WHEN `/auth/callback` handles the request
- THEN it MUST respond with HTTP 403
- AND it MUST NOT exchange the authorization code

### Requirement: Graph Token Validity and Refresh

`TokenStorage.getValidAccessToken()` MUST load Graph credentials from the shared token file, treat a token as expired when it is missing an expiry or is within the five-minute refresh buffer, and refresh it when a refresh token is available.

#### Scenario: Valid Graph access token is available

- GIVEN the shared token file contains `access_token` with `expires_at` more than five minutes in the future
- WHEN `getValidAccessToken()` is called
- THEN it MUST return the stored access token
- AND it MUST NOT call the token endpoint

#### Scenario: Graph access token requires refresh

- GIVEN the access token is expired or within five minutes of expiry
- AND a `refresh_token` exists
- WHEN `getValidAccessToken()` is called
- THEN it MUST request a new token with `grant_type=refresh_token`
- AND it MUST include the configured Graph scopes
- AND it MUST persist the new access token and expiry

#### Scenario: Concurrent Graph refreshes are requested

- GIVEN a Graph refresh is already in progress
- WHEN another caller requests a refresh
- THEN both callers MUST share the same `_refreshPromise`
- AND only one token-endpoint request SHALL be sent

#### Scenario: Microsoft rotates the Graph refresh token

- GIVEN a successful Graph refresh
- WHEN the response includes a new `refresh_token`
- THEN TokenStorage MUST persist the new refresh token
- AND when the response omits it, TokenStorage MUST retain the existing refresh token

### Requirement: Graph Authentication Status

The `check-auth-status` tool MUST resolve status through `TokenStorage.getValidAccessToken()` and MUST use the runtime's exact status messages.

#### Scenario: Graph token is valid or refresh succeeds

- GIVEN `getValidAccessToken()` returns a token
- WHEN `check-auth-status` is invoked
- THEN it MUST return exactly `Authenticated and ready`

#### Scenario: Graph credentials are unavailable or unusable

- GIVEN `getValidAccessToken()` returns `null`
- WHEN `check-auth-status` is invoked
- THEN it MUST return exactly `Not authenticated`

### Requirement: Authentication Tools

The MCP server MUST expose separate `authenticate` and `authenticate-flow` tools because Graph and Flow use different resource scopes.

#### Scenario: Graph authentication is requested

- GIVEN normal runtime mode
- WHEN `authenticate` is invoked
- THEN it MUST return the productive `/auth` URL and instructions to complete authentication in a browser

#### Scenario: Flow authentication is requested

- GIVEN normal runtime mode
- WHEN `authenticate-flow` is invoked
- THEN it MUST return `http://localhost:3333/auth/flow` and instructions to complete authentication in a browser

#### Scenario: Vault setup is requested

- GIVEN Vault mode is enabled
- WHEN `setup-vault` is invoked
- THEN it MUST run the explicit Vault setup path and return safe status text

### Requirement: Shared Token File Compatibility

TokenStorage MUST read the existing JSON token file at `~/.outlook-mcp-tokens.json`, preserve supported additive keys, and write it with owner-only permissions.

#### Scenario: Existing Graph token file is loaded

- GIVEN a valid pre-existing file containing Graph token keys
- WHEN `TokenStorage.getTokens()` is called
- THEN it MUST parse and return those keys without requiring a migration

#### Scenario: Token data is persisted

- GIVEN TokenStorage saves token data
- WHEN the shared file is written
- THEN it MUST contain valid JSON
- AND it MUST be created with mode `0600`

### Requirement: Legacy Token Manager Boundary

`auth/token-manager.js` MUST remain a deprecated compatibility module. New productive consumers MUST use the singleton TokenStorage exported by `auth/index.js`.

#### Scenario: Legacy exports remain available

- GIVEN a legacy import of `auth/token-manager.js`
- WHEN its exports are inspected
- THEN `loadTokenCache`, `saveTokenCache`, `getAccessToken`, and `createTestTokens` MUST remain available
- AND Flow token lifecycle methods MUST NOT be exported

#### Scenario: Productive handlers require credentials

- GIVEN a Graph or Power Automate handler
- WHEN it obtains an access token
- THEN it MUST use the singleton TokenStorage
- AND it MUST NOT add a new dependency on `token-manager.js`

## Known Implementation Gaps (Non-Normative)

These observations describe current limitations; they are not requirements to preserve:

- Productive initial Graph acquisition writes the token response as the whole file and can remove existing `flow_*` keys during Graph re-authentication.
- Graph refresh failure clears the shared in-memory token object, including Flow data, but the attempted save is a no-op after the object becomes `null`; stale credentials can remain on disk.
- The advertised `authenticate.force` argument is currently ignored.
- In test mode, `authenticate-flow` reports success after `createTestTokens()`, but that helper writes Graph-style test keys rather than `flow_*` keys.

See [`../../traceability.md`](../../traceability.md) for archive lineage and specification errata.
