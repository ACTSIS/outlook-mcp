# Auth — Persistent Authentication Specification

## Purpose

Define the behavior of the OAuth token lifecycle: scope configuration, token refresh, and auth status reporting. All auth modules MUST reference a single scope source in `config.js` to prevent silent scope downgrade on refresh.

## Requirements

### Requirement: Scope Unification

All auth modules that request scopes from Microsoft identity platform MUST reference `config.js` as the single source of truth for scope lists.

#### Scenario: All scope consumers reference config.js

- GIVEN `config.js` defines `AUTH_CONFIG.scopes` with the full scope set
- WHEN any auth module (`token-storage.js`, `outlook-auth-server.js`) constructs an OAuth request
- THEN it MUST use `config.AUTH_CONFIG.scopes` as the scope parameter
- AND it MUST NOT define its own inline scope list

#### Scenario: MS_SCOPES env var overrides config.js scopes

- GIVEN `process.env.MS_SCOPES` is set
- WHEN `token-storage.js` initializes its config
- THEN it MUST use `MS_SCOPES` instead of `config.AUTH_CONFIG.scopes`
- AND `outlook-auth-server.js` MUST NOT use `MS_SCOPES` (it uses `config.js` directly)

### Requirement: Full-Scope Token Refresh

`token-storage.refreshAccessToken()` MUST request the same scope set as the initial authorization code exchange.

#### Scenario: Refresh POST body includes full scopes

- GIVEN a stored refresh token from a previous auth with 10+ scopes
- WHEN `refreshAccessToken()` is called
- THEN the POST body to the token endpoint MUST include `scope` with all scopes from the configured list
- AND the `scope` parameter MUST NOT be a subset of the original auth scopes

#### Scenario: Refresh with downscoped env var override

- GIVEN `MS_SCOPES` is set to `"offline_access User.Read Mail.Read"`
- WHEN `refreshAccessToken()` is called
- THEN the POST body MUST use the `MS_SCOPES` value as the scope parameter
- AND the resulting token SHALL be limited to those scopes

### Requirement: Auth Status Accuracy

The `check-auth-status` tool MUST report authentication status based on `token-storage`'s token state, including its refresh capability.

#### Scenario: Token expired but refreshable reports authenticated

- GIVEN a stored token with `expires_at` in the past and a valid `refresh_token`
- WHEN `check-auth-status` is called
- THEN it MUST report "Authenticated" because `token-storage` can refresh the token on demand

#### Scenario: No tokens stored reports not authenticated

- GIVEN no token file exists at the configured path
- WHEN `check-auth-status` is called
- THEN it MUST report "Not authenticated"

### Requirement: offline_access Presence

The scope list in `config.js` MUST include `offline_access` to ensure Microsoft returns a refresh token during the authorization code exchange.

#### Scenario: offline_access in config.js scopes

- GIVEN `config.AUTH_CONFIG.scopes`
- WHEN the list is inspected
- THEN it MUST contain `"offline_access"`
- AND the initial auth URL and token exchange POST body MUST include `offline_access`

### Requirement: Backwards Compatibility

Existing code that reads tokens from the token file MUST continue to work after the scope unification.

#### Scenario: Token file format unchanged

- GIVEN a token file at `~/.outlook-mcp-tokens.json` created by the previous auth flow
- WHEN `token-storage.getTokens()` is called
- THEN it MUST parse and return the tokens successfully
- AND the token structure (`access_token`, `refresh_token`, `expires_at`, `expires_in`, `scope`) MUST be identical to the previous format

### Requirement: One-Time Re-Auth

After deploying the scope fix, users with existing tokens that were issued with a downscoped scope set MAY need to re-authenticate once to obtain a token with the full scope set.

#### Scenario: Existing downscoped token triggers re-auth prompt

- GIVEN a stored token whose `scope` field is a subset of `config.AUTH_CONFIG.scopes`
- WHEN `getValidAccessToken()` detects the token is expired and refresh returns a downscoped token
- THEN the system SHOULD surface a message indicating re-authentication may be needed
- AND the user MAY re-authenticate via the `authenticate` tool to obtain a full-scope token

### Requirement: Flow Token Methods in TokenStorage

TokenStorage MUST provide `getFlowAccessToken()`, `saveFlowTokens()`, `isFlowTokenExpired()`, and `getValidFlowAccessToken()` methods that read/write `flow_`-prefixed keys in the same token file.
(Previously: `getValidFlowAccessToken()` returned null on expiry without attempting refresh)

#### Scenario: getFlowAccessToken reads flow_access_token from file

- GIVEN a token file with `flow_access_token: "flow-token-123"` and `flow_expires_at` in the future
- WHEN `tokenStorage.getFlowAccessToken()` is called
- THEN it MUST return `"flow-token-123"`

#### Scenario: saveFlowTokens writes flow keys without removing Graph keys

- GIVEN a token file with `access_token: "graph-token"` and `refresh_token: "graph-refresh"`
- WHEN `tokenStorage.saveFlowTokens({ access_token: "flow-token", refresh_token: "flow-refresh", expires_in: 3600 })` is called
- THEN the file MUST contain both `access_token: "graph-token"` AND `flow_access_token: "flow-token"`
- AND the Graph keys MUST be unmodified

#### Scenario: isFlowTokenExpired returns true for expired flow token

- GIVEN `flow_expires_at` is `Date.now() - 60000`
- WHEN `tokenStorage.isFlowTokenExpired()` is called
- THEN it MUST return `true`

#### Scenario: getValidFlowAccessToken attempts refresh on expiry

- GIVEN a token file with expired `flow_access_token` and a valid `flow_refresh_token`
- WHEN `tokenStorage.getValidFlowAccessToken()` is called
- THEN it MUST call `refreshFlowAccessToken()`
- AND it MUST return the refreshed access token on success

#### Scenario: getValidFlowAccessToken returns null when no flow_refresh_token exists

- GIVEN a token file with expired `flow_access_token` and no `flow_refresh_token`
- WHEN `tokenStorage.getValidFlowAccessToken()` is called
- THEN it MUST return `null`
- AND it MUST NOT attempt an OAuth refresh

#### Scenario: getValidFlowAccessToken returns null when refresh fails

- GIVEN a token file with expired `flow_access_token` and a `flow_refresh_token`
- WHEN `getValidFlowAccessToken()` calls `refreshFlowAccessToken()` and it throws
- THEN it MUST return `null`
- AND flow tokens MUST be invalidated in the token file

#### Scenario: getValidFlowAccessToken loads tokens from file when not cached

- GIVEN a token file with `flow_access_token: "file-flow-token"` and `flow_expires_at` in the future
- WHEN `tokenStorage.getValidFlowAccessToken()` is called with `this.tokens` null
- THEN it MUST load tokens from the file
- AND it MUST return `"file-flow-token"`

### Requirement: Five Handler Import Migration

All five power-automate handlers MUST import Flow token access from `auth/token-storage` instead of `auth/token-manager`.

#### Scenario: All handlers import from token-storage

- GIVEN `power-automate/list-environments.js`, `list-flows.js`, `list-runs.js`, `run-flow.js`, `toggle-flow.js`
- WHEN each file's imports are inspected
- THEN each MUST import `getFlowAccessToken` from `../auth/token-storage`
- AND none MUST import `getFlowAccessToken` from `../auth/token-manager`

### Requirement: Flow Token Refresh

TokenStorage MUST provide `refreshFlowAccessToken()` that calls the Microsoft token endpoint with `grant_type=refresh_token` using the stored `flow_refresh_token` and `FLOW_SCOPE` from config. Concurrent calls MUST be deduplicated via a dedicated `_flowRefreshPromise`.

#### Scenario: Successful refresh returns new access token

- GIVEN a token file with `flow_refresh_token: "valid-flow-refresh"` and `flow_access_token` expired
- WHEN `tokenStorage.refreshFlowAccessToken()` is called
- THEN the POST body MUST include `grant_type=refresh_token`, `refresh_token=valid-flow-refresh`, and `scope=https://service.flow.microsoft.com/.default`
- AND `flow_access_token` and `flow_expires_at` MUST be updated in the token file
- AND it MUST return the new `flow_access_token`

#### Scenario: Concurrent refresh calls share a single HTTP request

- GIVEN two concurrent calls to `refreshFlowAccessToken()` while the token is expired
- WHEN both calls are made
- THEN only one HTTP request SHALL be sent to the token endpoint
- AND both calls SHALL resolve with the same access token
- AND `_flowRefreshPromise` SHALL be null after resolution

#### Scenario: Refresh token rotation preserves new flow_refresh_token

- GIVEN a token file with `flow_refresh_token: "old-flow-refresh"`
- WHEN `refreshFlowAccessToken()` returns a response with a new `refresh_token`
- THEN `flow_refresh_token` MUST be updated to the new value in the token file

#### Scenario: Refresh without rotation preserves existing flow_refresh_token

- GIVEN a token file with `flow_refresh_token: "existing-flow-refresh"`
- WHEN `refreshFlowAccessToken()` returns a response without a `refresh_token` field
- THEN `flow_refresh_token` MUST remain `"existing-flow-refresh"` unchanged

#### Scenario: Refresh failure invalidates flow tokens

- GIVEN a token file with `flow_refresh_token: "invalid-refresh"` and `flow_access_token` expired
- WHEN `refreshFlowAccessToken()` is called and the token endpoint returns an error
- THEN `flow_access_token` and `flow_refresh_token` MUST be cleared from the token file
- AND the method MUST throw an error

#### Scenario: Missing flow_refresh_token throws error

- GIVEN a token file with no `flow_refresh_token`
- WHEN `refreshFlowAccessToken()` is called
- THEN it MUST throw an error indicating no refresh token is available

### Requirement: token-manager.js Retention

`token-manager.js` MUST retain only `createTestTokens()` and remove `getFlowAccessToken()` and `saveFlowTokens()`.

#### Scenario: createTestTokens still works

- GIVEN `token-manager.js` after the migration
- WHEN `tokenManager.createTestTokens()` is called
- THEN it MUST create test tokens and save them to the token file
- AND it MUST return the test token object

#### Scenario: Flow methods removed from token-manager exports

- GIVEN `token-manager.js` after the migration
- WHEN `module.exports` is inspected
- THEN it MUST NOT include `getFlowAccessToken` or `saveFlowTokens`
- AND it MUST include `createTestTokens`
